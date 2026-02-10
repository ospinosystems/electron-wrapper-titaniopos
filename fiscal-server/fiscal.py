"""
Servidor Fiscal HKA - Versión Portable para TitanioPOS
Este servidor se integra con la aplicación Electron y maneja la comunicación con la impresora fiscal.
"""

from flask import Flask, request, jsonify
import subprocess
import os
import sys
import json
import queue
import threading
import time
import uuid
import re
import hashlib
from datetime import datetime, timedelta

# Importar módulo de comunicación serial directa HKA
try:
    from hka_serial import HKAPrinter, check_printer, send_fiscal_file, send_command as hka_send_command
    HKA_SERIAL_AVAILABLE = True
    print("[FISCAL] Módulo hka_serial cargado - comunicación serial directa disponible")
except ImportError:
    HKA_SERIAL_AVAILABLE = False
    print("[FISCAL] Módulo hka_serial no disponible - usando IntTFHKA.exe")

app = Flask(__name__)

# Obtener el directorio base del script
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Directorio de datos (para archivos temporales y de estado)
DATA_DIR = os.path.join(BASE_DIR, 'data')
if not os.path.exists(DATA_DIR):
    os.makedirs(DATA_DIR)

# Ruta del ejecutable IntTFHKA - configurable por PC via .env o endpoint /fiscal/config/programa
def get_programa_path():
    """Obtiene la ruta absoluta del ejecutable IntTFHKA.exe"""
    # 1. Variable de entorno INTFHKA_PATH (configurable por PC)
    env_path = os.environ.get('INTFHKA_PATH', '')
    if env_path:
        # Siempre resolver a ruta absoluta usando BASE_DIR como referencia
        if not os.path.isabs(env_path):
            env_path = os.path.abspath(os.path.join(BASE_DIR, env_path))
        if os.path.exists(env_path):
            return env_path
    
    # 2. SIEMPRE usar la carpeta del servidor (junto a fiscal.py)
    # Esto asegura que Factura.txt se escriba en la ubicación correcta
    local_path = os.path.abspath(os.path.join(BASE_DIR, 'IntTFHKA.exe'))
    return local_path  # Siempre usar esta ruta para mantener consistencia

def get_programa_dir():
    """Obtiene el directorio donde está IntTFHKA.exe"""
    return os.path.dirname(get_programa_path())

def get_puerto_dat_path():
    """Obtiene la ruta del archivo Puerto.dat (en el mismo directorio que IntTFHKA.exe)"""
    return os.path.join(get_programa_dir(), 'Puerto.dat')

def get_factura_path():
    """Obtiene la ruta del archivo Factura.txt (SIEMPRE en la carpeta fiscal-server)"""
    # CRÍTICO: Usar BASE_DIR directamente para evitar confusión con ubicaciones de IntTFHKA.exe
    return os.path.join(BASE_DIR, 'Factura.txt')

def get_retorno_path():
    """Obtiene la ruta del archivo Retorno.txt"""
    return os.path.join(get_programa_dir(), 'Retorno.txt')

def get_status_error_path():
    """Obtiene la ruta del archivo Status_Error.txt"""
    return os.path.join(get_programa_dir(), 'Status_Error.txt')

def configurar_puerto_com(puerto):
    """Configura el puerto COM en Puerto.dat"""
    try:
        puerto_path = get_puerto_dat_path()
        with open(puerto_path, 'w') as f:
            f.write(puerto)
        print(f"[FISCAL] Puerto COM configurado: {puerto} en {puerto_path}")
        return True
    except Exception as e:
        print(f"[FISCAL] Error configurando puerto: {e}")
        return False

def leer_puerto_com():
    """Lee el puerto COM actual desde Puerto.dat"""
    try:
        puerto_path = get_puerto_dat_path()
        if os.path.exists(puerto_path):
            with open(puerto_path, 'r') as f:
                return f.read().strip()
        return None
    except Exception as e:
        print(f"[FISCAL] Error leyendo puerto: {e}")
        return None

def leer_retorno():
    """Lee el contenido del archivo Retorno.txt"""
    try:
        retorno_path = get_retorno_path()
        if os.path.exists(retorno_path):
            with open(retorno_path, 'r', encoding='utf-8', errors='ignore') as f:
                return f.read().strip()
        return None
    except Exception as e:
        print(f"[FISCAL] Error leyendo retorno: {e}")
        return None

def leer_status_error():
    """Lee el contenido del archivo Status_Error.txt"""
    try:
        status_path = get_status_error_path()
        if os.path.exists(status_path):
            with open(status_path, 'r', encoding='utf-8', errors='ignore') as f:
                return f.read().strip()
        return None
    except Exception as e:
        print(f"[FISCAL] Error leyendo status_error: {e}")
        return None

RUTA_PROGRAMA = get_programa_path()
print(f"[FISCAL] IntTFHKA.exe path: {RUTA_PROGRAMA} (exists: {os.path.exists(RUTA_PROGRAMA)})")
print(f"[FISCAL] Puerto.dat path: {get_puerto_dat_path()}")
print(f"[FISCAL] Puerto COM actual: {leer_puerto_com()}")

# Cola thread-safe para procesar peticiones
cola_fiscal = queue.Queue()
# Lock para asegurar que solo un proceso fiscal se ejecute a la vez
lock_fiscal = threading.Lock()
# Diccionario para almacenar el estado de los trabajos
trabajos_estado = {}

# Almacén para IDs de caja ya ejecutados (para evitar doble ejecución)
ids_caja_ejecutados = set()
# Archivo para persistir los IDs ejecutados
ARCHIVO_IDS_EJECUTADOS = os.path.join(DATA_DIR, "ids_caja_ejecutados.txt")

# Archivo para facturas temporales - DEBE estar en el mismo directorio que IntTFHKA.exe
# Ya no usamos DATA_DIR para Factura.txt, se usa get_factura_path()

# Sistema anti-duplicados
peticiones_procesadas = {}  # hash_peticion -> {"timestamp": datetime, "job_id": str, "estado": str}
lock_duplicados = threading.Lock()
TIEMPO_EXPIRACION_DUPLICADOS = 300  # 5 minutos

# Puerto configurable via variable de entorno
PUERTO = int(os.environ.get('FISCAL_SERVER_PORT', 3000))

def cargar_ids_ejecutados():
    """Carga los IDs de caja ya ejecutados desde archivo"""
    global ids_caja_ejecutados
    try:
        if os.path.exists(ARCHIVO_IDS_EJECUTADOS):
            with open(ARCHIVO_IDS_EJECUTADOS, 'r') as f:
                ids_caja_ejecutados = set(line.strip() for line in f if line.strip())
    except Exception as e:
        print(f"Error cargando IDs ejecutados: {e}")
        ids_caja_ejecutados = set()

def guardar_id_ejecutado(id_caja):
    """Guarda un ID de caja como ejecutado"""
    global ids_caja_ejecutados
    try:
        ids_caja_ejecutados.add(id_caja)
        with open(ARCHIVO_IDS_EJECUTADOS, 'a') as f:
            f.write(f"{id_caja}\n")
    except Exception as e:
        print(f"Error guardando ID ejecutado: {e}")

def generar_hash_peticion(parametros, type_param, file_param):
    """Genera un hash único para identificar peticiones duplicadas"""
    try:
        datos_peticion = {
            "parametros": parametros,
            "type": type_param,
            "file": file_param
        }
        datos_str = json.dumps(datos_peticion, sort_keys=True, ensure_ascii=False)
        return hashlib.md5(datos_str.encode('utf-8')).hexdigest()
    except Exception as e:
        print(f"Error generando hash de petición: {e}")
        return None

def limpiar_peticiones_expiradas():
    """Limpia peticiones antigas del registro de duplicados"""
    global peticiones_procesadas
    try:
        with lock_duplicados:
            ahora = datetime.now()
            peticiones_expiradas = []
            
            for hash_peticion, info in peticiones_procesadas.items():
                tiempo_transcurrido = (ahora - info["timestamp"]).total_seconds()
                if tiempo_transcurrido > TIEMPO_EXPIRACION_DUPLICADOS:
                    peticiones_expiradas.append(hash_peticion)
            
            for hash_peticion in peticiones_expiradas:
                del peticiones_procesadas[hash_peticion]
                
            if peticiones_expiradas:
                print(f"Limpiadas {len(peticiones_expiradas)} peticiones expiradas del registro anti-duplicados")
                
    except Exception as e:
        print(f"Error limpiando peticiones expiradas: {e}")

def verificar_peticion_duplicada(hash_peticion):
    """Verifica si una petición ya está siendo procesada o fue procesada recientemente"""
    if not hash_peticion:
        return False, None
        
    with lock_duplicados:
        if hash_peticion in peticiones_procesadas:
            info = peticiones_procesadas[hash_peticion]
            return True, info
    return False, None

def registrar_peticion(hash_peticion, job_id, estado="pendiente"):
    """Registra una nueva petición en el sistema anti-duplicados"""
    if not hash_peticion:
        return
        
    with lock_duplicados:
        peticiones_procesadas[hash_peticion] = {
            "timestamp": datetime.now(),
            "job_id": job_id,
            "estado": estado
        }

def actualizar_estado_peticion(hash_peticion, nuevo_estado):
    """Actualiza el estado de una petición en el registro anti-duplicados"""
    if not hash_peticion:
        return
        
    with lock_duplicados:
        if hash_peticion in peticiones_procesadas:
            peticiones_procesadas[hash_peticion]["estado"] = nuevo_estado

def extraer_id_caja(parametros):
    """Extrae el ID de caja de los parámetros que empieza con 'i05Caja:' y retorna también la línea completa"""
    try:
        linea_completa = None
        id_caja = None
        
        if isinstance(parametros, str):
            try:
                parametros = json.loads(parametros)
            except:
                if "i05Caja:" in parametros:
                    match = re.search(r'i05Caja:([^,\]\s]+)', parametros)
                    if match:
                        id_caja = match.group(1)
                        linea_match = re.search(r'[^,\[\]]*i05Caja:[^,\[\]]*', parametros)
                        if linea_match:
                            linea_completa = linea_match.group(0).strip()
                return {"id_caja": id_caja, "linea_completa": linea_completa}

        if isinstance(parametros, list):
            for item in parametros:
                if isinstance(item, str) and "i05Caja:" in item:
                    if item.startswith("i05Caja:"):
                        id_caja = item.replace("i05Caja:", "")
                        linea_completa = item
                    else:
                        match = re.search(r'i05Caja:([^,\]\s]+)', item)
                        if match:
                            id_caja = match.group(1)
                            linea_completa = item
                    break
        
        return {"id_caja": id_caja, "linea_completa": linea_completa}
    except Exception as e:
        print(f"Error extrayendo ID de caja: {e}")
        return {"id_caja": None, "linea_completa": None}

def procesar_cola_fiscal():
    """Procesa la cola de peticiones fiscales de forma secuencial"""
    while True:
        try:
            trabajo = cola_fiscal.get(timeout=1)
            
            if trabajo is None:
                break
                
            job_id = trabajo['job_id']
            parametros = trabajo['parametros']
            type_param = trabajo['type']
            file_param = trabajo['file']
            hash_peticion = trabajo.get('hash_peticion')
            
            trabajos_estado[job_id]['estado'] = 'procesando'
            trabajos_estado[job_id]['fecha_inicio'] = datetime.now()
            
            actualizar_estado_peticion(hash_peticion, 'procesando')
            
            try:
                with lock_fiscal:
                    resultado = ejecutar_programa_fiscal(parametros, type_param, file_param)
                    
                if resultado['status'] == 'ok':
                    trabajos_estado[job_id]['estado'] = 'completado'
                    trabajos_estado[job_id]['resultado'] = resultado
                    actualizar_estado_peticion(hash_peticion, 'completado')
                else:
                    trabajos_estado[job_id]['estado'] = 'error'
                    trabajos_estado[job_id]['error'] = resultado['message']
                    actualizar_estado_peticion(hash_peticion, 'error')
                    
            except Exception as e:
                trabajos_estado[job_id]['estado'] = 'error'
                trabajos_estado[job_id]['error'] = str(e)
                actualizar_estado_peticion(hash_peticion, 'error')
                
            trabajos_estado[job_id]['fecha_fin'] = datetime.now()
            cola_fiscal.task_done()
            
        except queue.Empty:
            continue
        except Exception as e:
            print(f"Error en procesador de cola: {e}")
            continue

def ejecutar_con_hka_serial(parametros, type_param, file_param, puerto, id_caja, linea_completa, fecha_hora_ejecucion):
    """Ejecuta comando fiscal usando comunicación serial directa (sin IntTFHKA.exe)"""
    try:
        print(f"[{fecha_hora_ejecucion}] Usando hka_serial en {puerto}")
        
        if type_param in ["factura", "notacredito"]:
            # Escribir archivo de factura
            archivo_factura = get_factura_path()
            
            # CRÍTICO: Eliminar archivo anterior para evitar cache
            if os.path.exists(archivo_factura):
                os.remove(archivo_factura)
                print(f"[{fecha_hora_ejecucion}] Archivo anterior eliminado: {archivo_factura}")
            
            print(f"[{fecha_hora_ejecucion}] Escribiendo factura en: {archivo_factura}")
            
            with open(archivo_factura, "w", encoding='latin-1') as fp:
                if isinstance(parametros, str):
                    try:
                        parametros = json.loads(parametros)
                    except:
                        pass

                if isinstance(parametros, list):
                    for i, linea in enumerate(parametros):
                        linea_str = str(linea).rstrip()
                        if linea_str:
                            fp.write(f"{linea_str}\n")
                            print(f"[{fecha_hora_ejecucion}] Línea {i}: {linea_str}")
                else:
                    fp.write(str(parametros))
            
            # Enviar archivo usando hka_serial
            result = send_fiscal_file(puerto, archivo_factura)
            
            if result['success']:
                if id_caja:
                    guardar_id_ejecutado(id_caja)
                return {
                    "status": "ok",
                    "message": "Factura impresa correctamente (hka_serial)",
                    "method": "hka_serial",
                    "result": result['result'],
                    "id_caja": id_caja,
                    "linea_completa": linea_completa,
                    "fecha_hora": fecha_hora_ejecucion,
                    "puerto_com": puerto
                }
            else:
                return {
                    "status": "error",
                    "message": f"Error imprimiendo factura: {result['result']}",
                    "method": "hka_serial",
                    "id_caja": id_caja,
                    "fecha_hora": fecha_hora_ejecucion,
                    "puerto_com": puerto
                }
                
        elif type_param == "reportefiscal":
            # Enviar comando de reporte
            result = hka_send_command(puerto, parametros)
            
            if result['success']:
                return {
                    "status": "ok",
                    "message": "Reporte ejecutado correctamente (hka_serial)",
                    "method": "hka_serial",
                    "response": result['response'],
                    "fecha_hora": fecha_hora_ejecucion,
                    "puerto_com": puerto
                }
            else:
                return {
                    "status": "error",
                    "message": f"Error en reporte: {result.get('error', 'Unknown')}",
                    "method": "hka_serial",
                    "fecha_hora": fecha_hora_ejecucion,
                    "puerto_com": puerto
                }
        else:
            return {"status": "error", "message": f"Tipo de operación no soportado: {type_param}"}
            
    except Exception as e:
        return {"status": "error", "message": f"Error hka_serial: {str(e)}"}

def ejecutar_programa_fiscal(parametros, type_param, file_param):
    """Ejecuta el programa fiscal y espera a que termine"""
    try:
        id_caja_info = extraer_id_caja(parametros)
        id_caja = id_caja_info["id_caja"]
        linea_completa = id_caja_info["linea_completa"]
        fecha_hora_ejecucion = datetime.now().isoformat()
        
        if id_caja and id_caja in ids_caja_ejecutados:
            return {
                "status": "ok", 
                "message": f"ID de caja {id_caja} ya fue ejecutado anteriormente",
                "id_caja": id_caja,
                "linea_completa": linea_completa,
                "fecha_hora": fecha_hora_ejecucion,
                "ejecutado_previamente": True,
                "codigo_retorno": 0
            }
        
        puerto = leer_puerto_com()
        if not puerto:
            return {"status": "error", "message": "Puerto COM no configurado"}
        
        # USAR COMUNICACIÓN SERIAL DIRECTA SI ESTÁ DISPONIBLE
        if HKA_SERIAL_AVAILABLE:
            return ejecutar_con_hka_serial(parametros, type_param, file_param, puerto, id_caja, linea_completa, fecha_hora_ejecucion)
        
        # FALLBACK: Usar IntTFHKA.exe
        ruta_programa = get_programa_path()
        programa_dir = get_programa_dir()
        
        if not os.path.exists(ruta_programa):
            return {"status": "error", "message": f"Programa no encontrado en: {ruta_programa}"}
        
        archivo_factura = get_factura_path()
        
        if type_param in ["factura", "notacredito"]:
            # CRÍTICO: Eliminar archivo anterior para evitar cache
            if os.path.exists(archivo_factura):
                os.remove(archivo_factura)
                print(f"[{fecha_hora_ejecucion}] Archivo anterior eliminado: {archivo_factura}")
            
            print(f"[{fecha_hora_ejecucion}] Escribiendo factura en: {archivo_factura}")
            
            with open(archivo_factura, "w", encoding='utf-8') as fp:
                if isinstance(parametros, str):
                    try:
                        parametros = json.loads(parametros)
                    except:
                        pass

                if isinstance(parametros, list):
                    for i, linea in enumerate(parametros):
                        linea_str = str(linea).rstrip()
                        if linea_str:
                            fp.write(f"{linea_str}\n")
                            print(f"[{fecha_hora_ejecucion}] Línea {i}: {linea_str}")
                else:
                    fp.write(str(parametros))
            
            parametros = "SendFileCmd(Factura.txt)"
            
        elif type_param == "reportefiscal":
            parametros = f"SendCmd({parametros})"

        comando_str = f'IntTFHKA.exe {parametros}'
        
        print(f"[{fecha_hora_ejecucion}] Ejecutando: {comando_str}")
        print(f"[{fecha_hora_ejecucion}] CWD: {programa_dir}")
        print(f"[{fecha_hora_ejecucion}] Puerto COM: {puerto}")
        
        proceso = subprocess.Popen(
            comando_str, 
            shell=True, 
            stdout=subprocess.PIPE, 
            stderr=subprocess.PIPE,
            cwd=programa_dir
        )
        stdout, stderr = proceso.communicate(timeout=60)
        
        salida_fiscal = stdout.decode('utf-8', errors='ignore').strip() if stdout else ""
        error_fiscal = stderr.decode('utf-8', errors='ignore').strip() if stderr else ""
        
        # Leer archivos de respuesta de IntTFHKA
        retorno_contenido = leer_retorno()
        status_error_contenido = leer_status_error()
        
        print(f"[{fecha_hora_ejecucion}] Return code: {proceso.returncode}")
        print(f"[{fecha_hora_ejecucion}] Stdout: {salida_fiscal}")
        print(f"[{fecha_hora_ejecucion}] Retorno.txt: {retorno_contenido}")
        print(f"[{fecha_hora_ejecucion}] Status_Error.txt: {status_error_contenido}")
        if error_fiscal:
            print(f"[{fecha_hora_ejecucion}] Stderr: {error_fiscal}")
        
        # Códigos de retorno de IntTFHKA:
        # 0 = Error o sin respuesta
        # 3 = Comando ejecutado (factura impresa)
        # 4 = Comando ejecutado con advertencia
        # 5 = Comando ejecutado
        if proceso.returncode in [3, 4, 5] and id_caja:
            print(f"[{fecha_hora_ejecucion}] Retorno {proceso.returncode} - Guardando ID de caja: {id_caja}")
            guardar_id_ejecutado(id_caja)
        
        # Considerar exitoso si returncode es 3, 4 o 5
        if proceso.returncode in [3, 4, 5]:
            return {
                "status": "ok", 
                "message": "Factura impresa correctamente",
                "salida_fiscal": salida_fiscal,
                "retorno_txt": retorno_contenido,
                "status_error_txt": status_error_contenido,
                "codigo_retorno": proceso.returncode,
                "id_caja": id_caja,
                "linea_completa": linea_completa,
                "fecha_hora": fecha_hora_ejecucion
            }
        elif proceso.returncode == 0:
            # Retorno 0 generalmente significa error o timeout
            return {
                "status": "error", 
                "message": f"Error de comunicación con impresora fiscal. Retorno: {retorno_contenido}",
                "salida_fiscal": salida_fiscal,
                "retorno_txt": retorno_contenido,
                "status_error_txt": status_error_contenido,
                "codigo_retorno": proceso.returncode,
                "id_caja": id_caja,
                "linea_completa": linea_completa,
                "fecha_hora": fecha_hora_ejecucion
            }
        else:
            return {
                "status": "error", 
                "message": f"Error en ejecución. Código: {proceso.returncode}. {error_fiscal if error_fiscal else retorno_contenido}",
                "salida_fiscal": salida_fiscal,
                "retorno_txt": retorno_contenido,
                "status_error_txt": status_error_contenido,
                "error_fiscal": error_fiscal,
                "codigo_retorno": proceso.returncode,
                "id_caja": id_caja,
                "linea_completa": linea_completa,
                "fecha_hora": fecha_hora_ejecucion
            }
            
    except subprocess.TimeoutExpired:
        return {
            "status": "error", 
            "message": "Timeout: La impresora fiscal no respondió en 60 segundos",
            "fecha_hora": datetime.now().isoformat()
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.route('/fiscal', methods=['POST'])
def agregar_a_cola():
    """Agrega la petición a la cola y devuelve un ID de trabajo"""
    try:
        limpiar_peticiones_expiradas()
        
        data = request.get_json()
        parametros = data.get("parametros", "")
        type_param = data.get("type", "")
        file_param = data.get("file", "")
        
        hash_peticion = generar_hash_peticion(parametros, type_param, file_param)
        
        es_duplicada, info_duplicada = verificar_peticion_duplicada(hash_peticion)
        
        if es_duplicada:
            return jsonify({
                "status": "duplicada", 
                "message": f"Petición duplicada detectada. Job ID original: {info_duplicada['job_id']}",
                "job_id_original": info_duplicada['job_id'],
                "estado_original": info_duplicada['estado'],
                "timestamp_original": info_duplicada['timestamp'].isoformat(),
                "hash_peticion": hash_peticion
            }), 409
        
        job_id = str(uuid.uuid4())
        
        registrar_peticion(hash_peticion, job_id, "pendiente")
        
        trabajo = {
            'job_id': job_id,
            'parametros': parametros,
            'type': type_param,
            'file': file_param,
            'timestamp': datetime.now(),
            'hash_peticion': hash_peticion
        }
        
        trabajos_estado[job_id] = {
            'estado': 'pendiente',
            'fecha_creacion': datetime.now(),
            'trabajo': trabajo,
            'hash_peticion': hash_peticion
        }
        
        cola_fiscal.put(trabajo)
        
        return jsonify({
            "status": "ok", 
            "message": "Petición agregada a la cola",
            "job_id": job_id,
            "posicion_cola": cola_fiscal.qsize(),
            "hash_peticion": hash_peticion
        })
        
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/fiscal/estado/<job_id>', methods=['GET'])
def obtener_estado(job_id):
    """Obtiene el estado de un trabajo específico"""
    if job_id not in trabajos_estado:
        return jsonify({"status": "error", "message": "Trabajo no encontrado"}), 404
    
    trabajo = trabajos_estado[job_id]
    return jsonify({
        "job_id": job_id,
        "estado": trabajo['estado'],
        "fecha_creacion": trabajo['fecha_creacion'].isoformat(),
        "fecha_inicio": trabajo.get('fecha_inicio', {}).isoformat() if trabajo.get('fecha_inicio') else None,
        "fecha_fin": trabajo.get('fecha_fin', {}).isoformat() if trabajo.get('fecha_fin') else None,
        "resultado": trabajo.get('resultado'),
        "error": trabajo.get('error'),
        "hash_peticion": trabajo.get('hash_peticion')
    })

@app.route('/fiscal/cola/estado', methods=['GET'])
def estado_cola():
    """Devuelve el estado general de la cola"""
    pendientes = sum(1 for t in trabajos_estado.values() if t['estado'] == 'pendiente')
    procesando = sum(1 for t in trabajos_estado.values() if t['estado'] == 'procesando')
    completados = sum(1 for t in trabajos_estado.values() if t['estado'] == 'completado')
    errores = sum(1 for t in trabajos_estado.values() if t['estado'] == 'error')
    
    with lock_duplicados:
        duplicados_pendientes = sum(1 for info in peticiones_procesadas.values() if info['estado'] == 'pendiente')
        duplicados_procesando = sum(1 for info in peticiones_procesadas.values() if info['estado'] == 'procesando')
        duplicados_completados = sum(1 for info in peticiones_procesadas.values() if info['estado'] == 'completado')
        duplicados_errores = sum(1 for info in peticiones_procesadas.values() if info['estado'] == 'error')
        total_duplicados = len(peticiones_procesadas)
    
    return jsonify({
        "cola_tamaño": cola_fiscal.qsize(),
        "pendientes": pendientes,
        "procesando": procesando,
        "completados": completados,
        "errores": errores,
        "total_trabajos": len(trabajos_estado),
        "ruta_programa": get_programa_path(),
        "programa_existe": os.path.exists(get_programa_path()),
        "sistema_antiduplicados": {
            "total_peticiones_registradas": total_duplicados,
            "pendientes": duplicados_pendientes,
            "procesando": duplicados_procesando,
            "completados": duplicados_completados,
            "errores": duplicados_errores,
            "tiempo_expiracion_segundos": TIEMPO_EXPIRACION_DUPLICADOS
        }
    })

@app.route('/fiscal/config', methods=['GET'])
def obtener_config():
    """Devuelve la configuración actual del servidor"""
    return jsonify({
        "base_dir": BASE_DIR,
        "data_dir": DATA_DIR,
        "ruta_programa": get_programa_path(),
        "programa_dir": get_programa_dir(),
        "programa_existe": os.path.exists(get_programa_path()),
        "archivo_factura": get_factura_path(),
        "archivo_puerto": get_puerto_dat_path(),
        "puerto_com": leer_puerto_com(),
        "archivo_ids": ARCHIVO_IDS_EJECUTADOS,
        "puerto_servidor": PUERTO
    })

@app.route('/fiscal/config/programa', methods=['POST'])
def configurar_programa():
    """Configura la ruta del programa IntTFHKA"""
    global RUTA_PROGRAMA
    try:
        data = request.get_json()
        nueva_ruta = data.get("ruta", "")
        
        if not nueva_ruta:
            return jsonify({"status": "error", "message": "Ruta no especificada"}), 400
        
        if not os.path.exists(nueva_ruta):
            return jsonify({"status": "error", "message": f"El programa no existe en: {nueva_ruta}"}), 400
        
        os.environ['INTFHKA_PATH'] = nueva_ruta
        RUTA_PROGRAMA = nueva_ruta
        
        return jsonify({
            "status": "ok",
            "message": "Ruta configurada correctamente",
            "ruta_programa": nueva_ruta
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/fiscal/config/puerto', methods=['POST'])
def configurar_puerto():
    """Configura el puerto COM en Puerto.dat"""
    try:
        data = request.get_json()
        puerto = data.get("puerto", "")
        
        if not puerto:
            return jsonify({"status": "error", "message": "Puerto no especificado"}), 400
        
        # Validar formato del puerto (COM1, COM2, etc.)
        if not puerto.upper().startswith("COM"):
            return jsonify({"status": "error", "message": "Formato de puerto inválido. Use COM1, COM2, etc."}), 400
        
        if configurar_puerto_com(puerto.upper()):
            return jsonify({
                "status": "ok",
                "message": f"Puerto {puerto.upper()} configurado correctamente",
                "puerto_com": puerto.upper(),
                "archivo_puerto": get_puerto_dat_path()
            })
        else:
            return jsonify({"status": "error", "message": "Error al escribir Puerto.dat"}), 500
            
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/fiscal/config/puerto', methods=['GET'])
def obtener_puerto():
    """Obtiene el puerto COM actual"""
    try:
        puerto = leer_puerto_com()
        return jsonify({
            "status": "ok",
            "puerto_com": puerto,
            "archivo_puerto": get_puerto_dat_path()
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/fiscal/test-printer', methods=['POST'])
def test_printer():
    """Prueba la conexión con la impresora fiscal"""
    try:
        puerto = leer_puerto_com()
        if not puerto:
            return jsonify({"status": "error", "message": "Puerto COM no configurado. Configure Puerto.dat primero."}), 400
        
        # Usar comunicación serial directa si está disponible
        if HKA_SERIAL_AVAILABLE:
            print(f"[FISCAL] Test printer usando hka_serial en {puerto}")
            result = check_printer(puerto)
            
            return jsonify({
                "status": "ok" if result['connected'] else "error",
                "message": "Impresora conectada" if result['connected'] else "Impresora no detectada",
                "printer_connected": result['connected'],
                "puerto_com": puerto,
                "method": "hka_serial",
                "error": result.get('error')
            })
        
        # Fallback a IntTFHKA.exe si hka_serial no está disponible
        ruta_programa = get_programa_path()
        programa_dir = get_programa_dir()
        
        if not os.path.exists(ruta_programa):
            return jsonify({"status": "error", "message": f"Programa no encontrado: {ruta_programa}"}), 400
        
        comando = "IntTFHKA.exe CheckFprinter()"
        print(f"[FISCAL] Test: {comando} en {programa_dir}")
        
        proceso = subprocess.Popen(
            comando,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=programa_dir
        )
        stdout, stderr = proceso.communicate(timeout=30)
        
        retorno = leer_retorno()
        status_error = leer_status_error()
        printer_connected = retorno and retorno.startswith("T")
        
        return jsonify({
            "status": "ok" if printer_connected else "error",
            "message": "Impresora conectada" if printer_connected else "Impresora no detectada",
            "printer_connected": printer_connected,
            "return_code": proceso.returncode,
            "retorno_txt": retorno,
            "status_error_txt": status_error,
            "puerto_com": puerto,
            "method": "IntTFHKA.exe"
        })
        
    except subprocess.TimeoutExpired:
        return jsonify({"status": "error", "message": "Timeout esperando respuesta de la impresora"}), 500
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/fiscal/ids-ejecutados', methods=['GET'])
def obtener_ids_ejecutados():
    """Devuelve la lista de IDs de caja ya ejecutados"""
    return jsonify({
        "ids_ejecutados": list(ids_caja_ejecutados),
        "total": len(ids_caja_ejecutados)
    })

@app.route('/fiscal/ids-ejecutados', methods=['DELETE'])
def limpiar_ids_ejecutados():
    """Limpia todos los IDs de caja ejecutados"""
    global ids_caja_ejecutados
    try:
        ids_caja_ejecutados.clear()
        with open(ARCHIVO_IDS_EJECUTADOS, 'w') as f:
            f.write("")
        return jsonify({
            "status": "ok",
            "message": "IDs ejecutados limpiados correctamente"
        })
    except Exception as e:
        return jsonify({
            "status": "error",
            "message": f"Error limpiando IDs: {str(e)}"
        }), 500

@app.route('/health', methods=['GET'])
def health_check():
    """Endpoint de salud para verificar que el servidor está corriendo"""
    return jsonify({
        "status": "ok",
        "timestamp": datetime.now().isoformat(),
        "programa_fiscal": get_programa_path(),
        "programa_existe": os.path.exists(get_programa_path())
    })

# Inicializar el procesador de cola en un hilo separado
hilo_procesador = threading.Thread(target=procesar_cola_fiscal, daemon=True)
hilo_procesador.start()

def limpieza_periodica_duplicados():
    """Hilo que limpia periódicamente las peticiones expiradas"""
    while True:
        try:
            time.sleep(60)
            limpiar_peticiones_expiradas()
        except Exception as e:
            print(f"Error en limpieza periódica: {e}")

# Inicializar el limpiador de duplicados en un hilo separado
hilo_limpiador = threading.Thread(target=limpieza_periodica_duplicados, daemon=True)
hilo_limpiador.start()

# Cargar IDs de caja ya ejecutados
cargar_ids_ejecutados()

if __name__ == '__main__':
    print(f"=== Servidor Fiscal TitanioPOS ===")
    print(f"Base Dir: {BASE_DIR}")
    print(f"Data Dir: {DATA_DIR}")
    print(f"Ruta Programa: {get_programa_path()}")
    print(f"Programa Existe: {os.path.exists(get_programa_path())}")
    print(f"Puerto: {PUERTO}")
    print(f"================================")
    app.run(host='0.0.0.0', port=PUERTO)
