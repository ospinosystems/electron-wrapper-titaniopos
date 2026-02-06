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

app = Flask(__name__)

# Obtener el directorio base del script
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Directorio de datos (para archivos temporales y de estado)
DATA_DIR = os.path.join(BASE_DIR, 'data')
if not os.path.exists(DATA_DIR):
    os.makedirs(DATA_DIR)

# Ruta del ejecutable IntTFHKA - configurable via variable de entorno o argumento
def get_programa_path():
    """Obtiene la ruta del ejecutable IntTFHKA.exe"""
    # 1. Primero verificar variable de entorno
    if os.environ.get('INTFHKA_PATH'):
        return os.environ.get('INTFHKA_PATH')
    
    # 2. Verificar si existe en la carpeta del servidor
    local_path = os.path.join(BASE_DIR, 'IntTFHKA.exe')
    if os.path.exists(local_path):
        return local_path
    
    # 3. Verificar en C:\IntTFHKA (ubicación estándar)
    standard_path = r"C:\IntTFHKA\IntTFHKA.exe"
    if os.path.exists(standard_path):
        return standard_path
    
    # 4. Retornar la ruta estándar aunque no exista (generará error más adelante)
    return standard_path

RUTA_PROGRAMA = get_programa_path()

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

# Archivo para facturas temporales
ARCHIVO_FACTURA = os.path.join(DATA_DIR, "Factura.txt")

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
        
        # Usar archivo de factura en el directorio de datos
        if not file_param:
            file_param = ARCHIVO_FACTURA
        elif not os.path.isabs(file_param):
            file_param = os.path.join(DATA_DIR, file_param)
        
        if type_param in ["factura", "notacredito"]:
            with open(file_param, "w+") as fp:
                fp.write("")
                
                if isinstance(parametros, str):
                    try:
                        parametros = json.loads(parametros)
                    except:
                        pass

                if isinstance(parametros, list):
                    for numero in parametros:
                        fp.write(f"{numero}")
                else:
                    fp.write(str(parametros))
                    
            parametros = f"SendFileCmd({file_param})"
        elif type_param == "reportefiscal":
            parametros = f"SendCmd({parametros})"

        # Verificar ruta del programa
        ruta_programa = get_programa_path()
        if not os.path.exists(ruta_programa):
            return {"status": "error", "message": f"Programa no encontrado en: {ruta_programa}"}

        comando = [ruta_programa] + parametros.split()
        
        proceso = subprocess.Popen(comando, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        stdout, stderr = proceso.communicate()
        
        salida_fiscal = stdout.decode('utf-8', errors='ignore').strip() if stdout else ""
        error_fiscal = stderr.decode('utf-8', errors='ignore').strip() if stderr else ""
        
        if salida_fiscal:
            print(f"[{fecha_hora_ejecucion}] Línea: {linea_completa}")
            print(f"[{fecha_hora_ejecucion}] Salida fiscal: {salida_fiscal}")
        if error_fiscal:
            print(f"[{fecha_hora_ejecucion}] Error: {error_fiscal}")
        
        if proceso.returncode in [3, 4, 5] and id_caja:
            print(f"[{fecha_hora_ejecucion}] Retorno {proceso.returncode} - Guardando ID de caja: {id_caja}")
            guardar_id_ejecutado(id_caja)
        
        if proceso.returncode == 0:
            return {
                "status": "ok", 
                "message": "Programa ejecutado correctamente",
                "salida_fiscal": salida_fiscal,
                "codigo_retorno": proceso.returncode,
                "id_caja": id_caja,
                "linea_completa": linea_completa,
                "fecha_hora": fecha_hora_ejecucion
            }
        else:
            return {
                "status": "error", 
                "message": f"Error en ejecución: {error_fiscal if error_fiscal else 'Error desconocido'}",
                "salida_fiscal": salida_fiscal,
                "error_fiscal": error_fiscal,
                "codigo_retorno": proceso.returncode,
                "id_caja": id_caja,
                "linea_completa": linea_completa,
                "fecha_hora": fecha_hora_ejecucion
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
        "programa_existe": os.path.exists(get_programa_path()),
        "archivo_factura": ARCHIVO_FACTURA,
        "archivo_ids": ARCHIVO_IDS_EJECUTADOS,
        "puerto": PUERTO
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
