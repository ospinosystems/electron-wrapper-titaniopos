"""
Servidor Fiscal HKA para TitanioPOS.

Backend unico: tfhka.py (port del SDK TfhkaNet.dll). Se comunica directo con la
impresora fiscal por serial o TCP; ya NO usa IntTFHKA.exe ni hka_serial.py.

Ademas de imprimir facturas/notas, expone endpoints que LEEN las respuestas de la
fiscal: status decodificado, reportes X/Z (data e impresion), datos S1..S8, etc.
"""

import os
import sys

# Asegurar que el dir del script y el site-packages del Python embebido esten en
# sys.path (con Python embebido en Windows el ._pth puede omitirlos).
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
_PY_DIR = os.path.dirname(os.path.abspath(sys.executable))
_SITE_PACKAGES = os.path.join(_PY_DIR, 'Lib', 'site-packages')
if os.path.isdir(_SITE_PACKAGES) and _SITE_PACKAGES not in sys.path:
    sys.path.insert(0, _SITE_PACKAGES)

print(f"[FISCAL] Python exec: {sys.executable}")
print(f"[FISCAL] site-packages probe: {_SITE_PACKAGES} (exists={os.path.isdir(_SITE_PACKAGES)})")

try:
    from flask import Flask, request, jsonify
except ModuleNotFoundError as e:
    print(f"[FISCAL] FATAL: Flask no se encuentra. {e}")
    sys.exit(2)

import json
import queue
import threading
import time
import uuid
import re
import hashlib
from datetime import datetime

from tfhka import Tfhka, parse_s1

app = Flask(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


# --------------------------------------------------------------------------
#  Runtime dir escribible (en produccion BASE_DIR vive en Program Files)
# --------------------------------------------------------------------------
def _resolve_runtime_dir():
    env_dir = os.environ.get('FISCAL_RUNTIME_DIR', '').strip()
    if env_dir:
        try:
            os.makedirs(env_dir, exist_ok=True)
            test_path = os.path.join(env_dir, '.write_test')
            with open(test_path, 'w') as f:
                f.write('ok')
            os.remove(test_path)
            return env_dir
        except Exception as e:
            print(f"[FISCAL] FISCAL_RUNTIME_DIR no escribible ({env_dir}): {e}. Usando BASE_DIR.")
    return BASE_DIR


RUNTIME_DIR = _resolve_runtime_dir()
DATA_DIR = os.path.join(RUNTIME_DIR, 'data')
os.makedirs(DATA_DIR, exist_ok=True)
print(f"[FISCAL] RUNTIME_DIR: {RUNTIME_DIR}")

PUERTO = int(os.environ.get('FISCAL_SERVER_PORT', 3000))


# --------------------------------------------------------------------------
#  Puerto COM (Puerto.dat)  y  factura de auditoria (Factura.txt)
# --------------------------------------------------------------------------
def get_puerto_dat_path():
    runtime_path = os.path.join(RUNTIME_DIR, 'Puerto.dat')
    if os.path.exists(runtime_path):
        return runtime_path
    legacy_path = os.path.join(BASE_DIR, 'Puerto.dat')
    if os.path.exists(legacy_path) and RUNTIME_DIR != BASE_DIR:
        return legacy_path
    return runtime_path


def get_factura_path():
    return os.path.join(RUNTIME_DIR, 'Factura.txt')


def configurar_puerto_com(puerto):
    try:
        with open(get_puerto_dat_path(), 'w') as f:
            f.write(puerto)
        print(f"[FISCAL] Puerto COM configurado: {puerto}")
        return True
    except Exception as e:
        print(f"[FISCAL] Error configurando puerto: {e}")
        return False


def leer_puerto_com():
    try:
        p = get_puerto_dat_path()
        if os.path.exists(p):
            with open(p, 'r') as f:
                return f.read().strip()
        return None
    except Exception as e:
        print(f"[FISCAL] Error leyendo puerto: {e}")
        return None


def _nueva_impresora():
    """Instancia Tfhka con el puerto configurado. Devuelve (impresora, error)."""
    puerto = leer_puerto_com()
    if not puerto:
        return None, "Puerto COM no configurado"
    return Tfhka(port=puerto), None


print(f"[FISCAL] Puerto.dat path: {get_puerto_dat_path()}")
print(f"[FISCAL] Puerto COM actual: {leer_puerto_com()}")


# --------------------------------------------------------------------------
#  Cola secuencial + anti-duplicados (para impresion de facturas)
# --------------------------------------------------------------------------
cola_fiscal = queue.Queue()
lock_fiscal = threading.Lock()
trabajos_estado = {}

ids_caja_ejecutados = set()
ARCHIVO_IDS_EJECUTADOS = os.path.join(DATA_DIR, "ids_caja_ejecutados.txt")

peticiones_procesadas = {}
lock_duplicados = threading.Lock()
TIEMPO_EXPIRACION_DUPLICADOS = 300


def cargar_ids_ejecutados():
    global ids_caja_ejecutados
    try:
        if os.path.exists(ARCHIVO_IDS_EJECUTADOS):
            with open(ARCHIVO_IDS_EJECUTADOS, 'r') as f:
                ids_caja_ejecutados = set(line.strip() for line in f if line.strip())
    except Exception as e:
        print(f"Error cargando IDs ejecutados: {e}")
        ids_caja_ejecutados = set()


def guardar_id_ejecutado(id_caja):
    try:
        ids_caja_ejecutados.add(id_caja)
        with open(ARCHIVO_IDS_EJECUTADOS, 'a') as f:
            f.write(f"{id_caja}\n")
    except Exception as e:
        print(f"Error guardando ID ejecutado: {e}")


def generar_hash_peticion(parametros, type_param, file_param):
    try:
        datos = {"parametros": parametros, "type": type_param, "file": file_param}
        return hashlib.md5(json.dumps(datos, sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest()
    except Exception as e:
        print(f"Error generando hash: {e}")
        return None


def limpiar_peticiones_expiradas():
    try:
        with lock_duplicados:
            ahora = datetime.now()
            expiradas = [h for h, i in peticiones_procesadas.items()
                         if (ahora - i["timestamp"]).total_seconds() > TIEMPO_EXPIRACION_DUPLICADOS]
            for h in expiradas:
                del peticiones_procesadas[h]
    except Exception as e:
        print(f"Error limpiando peticiones: {e}")


def verificar_o_registrar_peticion(h, job_id):
    """Chequeo de duplicado + registro en UNA seccion critica: con verificar y
    registrar por separado, dos POST identicos casi simultaneos (doble clic /
    reintento de red) pasaban ambos la verificacion y se encolaban los dos.
    Devuelve (es_duplicada, info_original)."""
    if not h:
        return False, None
    with lock_duplicados:
        if h in peticiones_procesadas:
            return True, peticiones_procesadas[h]
        peticiones_procesadas[h] = {"timestamp": datetime.now(), "job_id": job_id, "estado": "pendiente"}
    return False, None


def liberar_peticion(h):
    """Libera la entrada anti-duplicados cuando el job termina en ERROR: un
    intento fallido no debe responder 409 al reintento legitimo de la MISMA
    factura (contrato con el POS: reenviar solo reimprime si no salio; los
    impresos con exito quedan protegidos por id_caja en ids_ejecutados)."""
    if not h:
        return
    with lock_duplicados:
        peticiones_procesadas.pop(h, None)


def actualizar_estado_peticion(h, estado):
    if not h:
        return
    with lock_duplicados:
        if h in peticiones_procesadas:
            peticiones_procesadas[h]["estado"] = estado


def extraer_id_caja(parametros):
    """Extrae el ID de caja de una linea 'i05Caja:...' para el anti-duplicados."""
    try:
        if isinstance(parametros, str):
            try:
                parametros = json.loads(parametros)
            except Exception:
                m = re.search(r'i05Caja:([^,\]\s]+)', parametros)
                if m:
                    return {"id_caja": m.group(1), "linea_completa": m.group(0)}
                return {"id_caja": None, "linea_completa": None}
        if isinstance(parametros, list):
            for item in parametros:
                if isinstance(item, str) and "i05Caja:" in item:
                    if item.startswith("i05Caja:"):
                        # .strip(): la linea real es 'i05Caja: 2 - X' (espacio tras los
                        # dos puntos). Guardar el id CON espacio rompia el dedup tras un
                        # reinicio: cargar_ids_ejecutados hace line.strip() al leer el
                        # archivo y el id re-extraido (' 2 - X') nunca coincidia -> el
                        # reenvio de un documento YA IMPRESO se imprimia de nuevo.
                        return {"id_caja": item.replace("i05Caja:", "").strip(), "linea_completa": item}
                    m = re.search(r'i05Caja:([^,\]\s]+)', item)
                    if m:
                        return {"id_caja": m.group(1).strip(), "linea_completa": item}
        return {"id_caja": None, "linea_completa": None}
    except Exception as e:
        print(f"Error extrayendo ID de caja: {e}")
        return {"id_caja": None, "linea_completa": None}


def _lineas_de(parametros):
    """Normaliza `parametros` (lista o JSON string de lista) a lista de strings."""
    if isinstance(parametros, str):
        try:
            parametros = json.loads(parametros)
        except Exception:
            return [parametros]
    if isinstance(parametros, list):
        return [str(x) for x in parametros]
    return [str(parametros)]


_REASON_MSG = {
    "open_failed": "No se pudo abrir el puerto de la impresora fiscal",
    "no_response": "La impresora fiscal no responde (revise cable/encendido)",
    "paper": "La impresora fiscal no tiene papel",
    "nak_line": "La impresora rechazó una línea del documento",
    "warn_not_closed": "El documento pudo no haber cerrado correctamente",
}


def _mensaje_fallo_impresion(diag):
    base = _REASON_MSG.get(diag.get("reason"), "Error imprimiendo el documento")
    st = diag.get("pre_status") or diag.get("post_status")
    if diag.get("reason") == "nak_line" and diag.get("line"):
        base += f" (línea: {diag['line']!r})"
    if st and st.get("error") not in (None, "00"):
        base += f" — estado {st.get('status')}/{st.get('error')}: {st.get('error_description')}"
    return base


def _log_fiscal_attempt(tipo, id_caja, diag):
    """Registra cada intento de impresión (con estado pre/post) para post-mortem.

    Que nunca vuelva a ser 'sin explicación': queda en data/fiscal_intentos_YYYYMMDD.log.
    """
    try:
        ahora = datetime.now()
        path = os.path.join(DATA_DIR, f"fiscal_intentos_{ahora.strftime('%Y%m%d')}.log")
        entry = {"ts": ahora.isoformat(), "tipo": tipo, "id_caja": id_caja,
                 "ok": diag.get("ok"), "reason": diag.get("reason"),
                 "recovered_open_doc": diag.get("recovered_open_doc"),
                 "pre_status": diag.get("pre_status"), "post_status": diag.get("post_status"),
                 "line": diag.get("line"), "sent": diag.get("sent")}
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception as e:
        print(f"[FISCAL] No se pudo escribir log de intento: {e}")


def ejecutar_programa_fiscal(parametros, type_param, file_param):
    """Imprime factura/nota o envia un comando de reporte. Usa tfhka directo."""
    try:
        info = extraer_id_caja(parametros)
        id_caja, linea_completa = info["id_caja"], info["linea_completa"]
        fecha = datetime.now().isoformat()

        if id_caja and id_caja in ids_caja_ejecutados:
            return {"status": "ok", "message": f"ID {id_caja} ya ejecutado", "id_caja": id_caja,
                    "linea_completa": linea_completa, "fecha_hora": fecha, "ejecutado_previamente": True}

        impresora, err = _nueva_impresora()
        if err:
            return {"status": "error", "message": err}

        if type_param in ("factura", "notacredito"):
            lineas = _lineas_de(parametros)

            # NOTA DE CRÉDITO: la HKA exige la referencia COMPLETA de la factura
            # original (iF* numérico + iD* + iI* serial) para abrir el documento;
            # sin iI* rechaza la primera línea del cuerpo (visto en HW 15-07-2026:
            # NAK en 'A<motivo>' en toda NC sin serial). Si el frontend/config no
            # mandó iI*, inyectamos el serial de ESTA máquina leyendo S1 (caso
            # normal: la factura original salió de esta misma caja).
            if type_param == "notacredito" and not any(str(l).startswith("iI*") for l in lineas):
                try:
                    s1 = impresora.get_s1_data()
                    serial = (s1 or {}).get("registered_machine_number")
                    if serial and str(serial).strip():
                        idx = next((i + 1 for i, l in enumerate(lineas)
                                    if str(l).startswith("iD*")), 0)
                        lineas.insert(idx, f"iI*{str(serial).strip()}")
                        print(f"[FISCAL] NC sin iI*: serial {serial} inyectado desde S1")
                    else:
                        print("[FISCAL] NC sin iI* y S1 sin serial: se envia tal cual")
                except Exception as e:
                    print(f"[FISCAL] NC sin iI*: no se pudo leer S1 ({e}); se envia tal cual")

            # Guardar copia de auditoria de lo que se envio.
            try:
                fp = get_factura_path()
                if os.path.exists(fp):
                    os.remove(fp)
                with open(fp, "w", encoding='latin-1') as f:
                    for l in lineas:
                        if str(l).strip():
                            f.write(f"{str(l).rstrip()}\n")
            except Exception as e:
                print(f"[FISCAL] No se pudo escribir Factura.txt de auditoria: {e}")

            # Flujo con diagnóstico: recupera doc abierto, valida papel/comunicación,
            # envía con ACK+reintento y confirma cierre. NUNCA da éxito silencioso.
            diag = impresora.print_invoice(lineas)
            _log_fiscal_attempt(type_param, id_caja, diag)  # post-mortem persistente
            if diag.get("ok"):
                if id_caja:
                    guardar_id_ejecutado(id_caja)
                # SENIAT: capturar el número fiscal asignado + serial de la máquina
                # (leyendo S1). Es lo que una futura nota de crédito debe referenciar.
                # OJO: con el cierre NO confirmado (warn_not_closed) el S1 devolvería
                # el número del documento ANTERIOR — mejor sin número que uno ajeno
                # sincronizado al backend (una NC referenciaría la factura equivocada).
                numero_fiscal = None
                maquina = None
                cierre_confirmado = diag.get("reason") not in ("warn_not_closed",)
                if cierre_confirmado:
                    try:
                        s1 = impresora.get_s1_data()
                        if s1:
                            maquina = {"serial": s1.get("registered_machine_number"),
                                       "rif": s1.get("rif"),
                                       "fecha_hora": s1.get("current_printer_datetime")}
                            numero_fiscal = (s1.get("last_credit_note_number")
                                             if type_param == "notacredito"
                                             else s1.get("last_invoice_number"))
                    except Exception:
                        pass
                mensaje = ("Documento impreso correctamente" if cierre_confirmado
                           else "Documento impreso; cierre no confirmado (numero fiscal no capturado)")
                return {"status": "ok", "message": mensaje,
                        "id_caja": id_caja, "linea_completa": linea_completa, "fecha_hora": fecha,
                        "puerto_com": impresora.port, "diagnostico": diag,
                        "numero_fiscal": numero_fiscal, "machine": maquina}
            return {"status": "error",
                    "message": _mensaje_fallo_impresion(diag),
                    "reason": diag.get("reason"), "printer_status": diag.get("pre_status") or diag.get("post_status"),
                    "id_caja": id_caja, "fecha_hora": fecha, "puerto_com": impresora.port,
                    "diagnostico": diag}

        elif type_param == "reportefiscal":
            cmd = parametros if isinstance(parametros, str) else str(parametros)
            ok = impresora.send_cmd(cmd)
            return {"status": "ok" if ok else "error",
                    "message": "Comando ejecutado" if ok else f"Error en comando: {impresora.last_error}",
                    "printer_status": impresora.get_printer_status() if not ok else None,
                    "fecha_hora": fecha, "puerto_com": impresora.port}

        elif type_param == "documentonofiscal":
            # Presupuesto / comprobante interno: texto libre, NO es documento fiscal.
            lineas = _lineas_de(parametros)
            diag = impresora.print_non_fiscal(lineas)
            _log_fiscal_attempt(type_param, id_caja, diag)
            if diag.get("ok"):
                if id_caja:
                    guardar_id_ejecutado(id_caja)
                return {"status": "ok", "message": "Documento no fiscal impreso",
                        "id_caja": id_caja, "linea_completa": linea_completa, "fecha_hora": fecha,
                        "puerto_com": impresora.port, "diagnostico": diag}
            return {"status": "error", "message": _mensaje_fallo_impresion(diag),
                    "reason": diag.get("reason"), "printer_status": diag.get("pre_status") or diag.get("post_status"),
                    "id_caja": id_caja, "fecha_hora": fecha, "puerto_com": impresora.port, "diagnostico": diag}
        else:
            return {"status": "error", "message": f"Tipo no soportado: {type_param}"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


def procesar_cola_fiscal():
    while True:
        try:
            trabajo = cola_fiscal.get(timeout=1)
            if trabajo is None:
                break
            job_id = trabajo['job_id']
            h = trabajo.get('hash_peticion')
            trabajos_estado[job_id]['estado'] = 'procesando'
            trabajos_estado[job_id]['fecha_inicio'] = datetime.now()
            actualizar_estado_peticion(h, 'procesando')
            try:
                with lock_fiscal:
                    resultado = ejecutar_programa_fiscal(trabajo['parametros'], trabajo['type'], trabajo['file'])
                if resultado['status'] == 'ok':
                    trabajos_estado[job_id]['estado'] = 'completado'
                    trabajos_estado[job_id]['resultado'] = resultado
                    actualizar_estado_peticion(h, 'completado')
                else:
                    trabajos_estado[job_id]['estado'] = 'error'
                    trabajos_estado[job_id]['error'] = resultado['message']
                    trabajos_estado[job_id]['resultado'] = resultado
                    liberar_peticion(h)  # que el reintento legitimo no reciba 409
            except Exception as e:
                trabajos_estado[job_id]['estado'] = 'error'
                trabajos_estado[job_id]['error'] = str(e)
                liberar_peticion(h)
            trabajos_estado[job_id]['fecha_fin'] = datetime.now()
            cola_fiscal.task_done()
        except queue.Empty:
            continue
        except Exception as e:
            print(f"Error en procesador de cola: {e}")
            continue


# --------------------------------------------------------------------------
#  Endpoints: impresion en cola (factura/nota/reporte)
# --------------------------------------------------------------------------
@app.route('/fiscal', methods=['POST'])
def agregar_a_cola():
    try:
        limpiar_peticiones_expiradas()
        data = request.get_json()
        parametros = data.get("parametros", "")
        type_param = data.get("type", "")
        file_param = data.get("file", "")

        h = generar_hash_peticion(parametros, type_param, file_param)
        job_id = str(uuid.uuid4())
        es_dup, info = verificar_o_registrar_peticion(h, job_id)
        if es_dup:
            return jsonify({"status": "duplicada",
                            "message": f"Peticion duplicada. Job original: {info['job_id']}",
                            "job_id_original": info['job_id'], "estado_original": info['estado'],
                            "hash_peticion": h}), 409
        trabajo = {'job_id': job_id, 'parametros': parametros, 'type': type_param,
                   'file': file_param, 'timestamp': datetime.now(), 'hash_peticion': h}
        trabajos_estado[job_id] = {'estado': 'pendiente', 'fecha_creacion': datetime.now(),
                                   'trabajo': trabajo, 'hash_peticion': h}
        cola_fiscal.put(trabajo)
        return jsonify({"status": "ok", "message": "Peticion agregada a la cola",
                        "job_id": job_id, "posicion_cola": cola_fiscal.qsize(), "hash_peticion": h})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/fiscal/estado/<job_id>', methods=['GET'])
def obtener_estado(job_id):
    if job_id not in trabajos_estado:
        return jsonify({"status": "error", "message": "Trabajo no encontrado"}), 404
    t = trabajos_estado[job_id]
    return jsonify({"job_id": job_id, "estado": t['estado'],
                    "fecha_creacion": t['fecha_creacion'].isoformat(),
                    "fecha_inicio": t['fecha_inicio'].isoformat() if t.get('fecha_inicio') else None,
                    "fecha_fin": t['fecha_fin'].isoformat() if t.get('fecha_fin') else None,
                    "resultado": t.get('resultado'), "error": t.get('error'),
                    "hash_peticion": t.get('hash_peticion')})


@app.route('/fiscal/cola/estado', methods=['GET'])
def estado_cola():
    def cnt(e):
        return sum(1 for t in trabajos_estado.values() if t['estado'] == e)
    return jsonify({"cola_tamano": cola_fiscal.qsize(), "pendientes": cnt('pendiente'),
                    "procesando": cnt('procesando'), "completados": cnt('completado'),
                    "errores": cnt('error'), "total_trabajos": len(trabajos_estado),
                    "puerto_com": leer_puerto_com()})


# --------------------------------------------------------------------------
#  Endpoints: LECTURA de la fiscal (status / reportes / datos S*)
# --------------------------------------------------------------------------
@app.route('/fiscal/status', methods=['GET'])
def fiscal_status():
    imp, err = _nueva_impresora()
    if err:
        return jsonify({"status": "error", "message": err}), 400
    return jsonify({"status": "ok", "printer_status": imp.get_printer_status(), "puerto_com": imp.port})


@app.route('/fiscal/check', methods=['GET', 'POST'])
def fiscal_check():
    imp, err = _nueva_impresora()
    if err:
        return jsonify({"status": "error", "message": err}), 400
    conectada = imp.check_fprinter()
    return jsonify({"status": "ok" if conectada else "error",
                    "printer_connected": conectada,
                    "message": "Impresora conectada" if conectada else "Impresora no detectada",
                    "error": imp.last_error if not conectada else None, "puerto_com": imp.port})


@app.route('/fiscal/drawer', methods=['GET'])
def fiscal_drawer():
    imp, err = _nueva_impresora()
    if err:
        return jsonify({"status": "error", "message": err}), 400
    return jsonify({"status": "ok", "drawer_open": imp.check_drawer(), "puerto_com": imp.port})


@app.route('/fiscal/command', methods=['POST'])
def fiscal_command():
    """Envia un comando crudo y espera ACK (SendCmd)."""
    imp, err = _nueva_impresora()
    if err:
        return jsonify({"status": "error", "message": err}), 400
    cmd = (request.get_json() or {}).get("cmd", "")
    if not cmd:
        return jsonify({"status": "error", "message": "Falta 'cmd'"}), 400
    # lock_fiscal: un comando crudo no debe intercalarse dentro de la impresión
    # de una factura de la cola (línea ajena en medio del documento).
    with lock_fiscal:
        ok = imp.send_cmd(cmd)
    return jsonify({"status": "ok" if ok else "error", "acked": ok,
                    "printer_status": imp.get_printer_status() if not ok else None, "cmd": cmd})


@app.route('/fiscal/cancel', methods=['POST'])
def fiscal_cancel():
    """Cancela el documento fiscal en curso (SendCmd 7)."""
    imp, err = _nueva_impresora()
    if err:
        return jsonify({"status": "error", "message": err}), 400
    with lock_fiscal:
        ok = imp.cancel_document()
    return jsonify({"status": "ok" if ok else "error", "acked": ok})


@app.route('/fiscal/sdata/<cmd>', methods=['GET'])
def fiscal_sdata(cmd):
    """Getter generico de status Sx (S1..S8, SG, SM, SR, SS...). Devuelve el payload crudo.

    Si es S1, tambien lo devuelve parseado (RIF, serial, contadores).
    """
    imp, err = _nueva_impresora()
    if err:
        return jsonify({"status": "error", "message": err}), 400
    # SOLO comandos de LECTURA Sx: el patron viejo [A-Za-z0-9]{1,4} dejaba pasar
    # comandos de ACCION por un endpoint GET ('I0Z' = cierre Z REAL e irreversible,
    # '7' = cancelar el documento en curso).
    if not re.match(r'^[Ss][A-Za-z0-9]{1,3}$', cmd):
        return jsonify({"status": "error", "message": "Comando invalido (solo status Sx)"}), 400
    raw = imp.get_status_data(cmd.upper())
    if raw is None:
        return jsonify({"status": "error", "message": "Sin respuesta de la impresora",
                        "printer_status": imp.get_printer_status(), "cmd": cmd.upper()}), 502
    resp = {"status": "ok", "cmd": cmd.upper(), "raw": raw}
    if cmd.upper() == "S1":
        resp["parsed"] = parse_s1(raw)
    return jsonify(resp)


@app.route('/fiscal/s1', methods=['GET'])
def fiscal_s1():
    """Datos de la maquina (S1): RIF, serial registrado, contadores, fecha/hora."""
    imp, err = _nueva_impresora()
    if err:
        return jsonify({"status": "error", "message": err}), 400
    data = imp.get_s1_data()
    if data is None:
        return jsonify({"status": "error", "message": "Sin respuesta",
                        "printer_status": imp.get_printer_status()}), 502
    return jsonify({"status": "ok", "s1": data})


@app.route('/fiscal/report/x', methods=['GET'])
def report_x():
    """Lee (no imprime) el reporte X con totales del dia."""
    imp, err = _nueva_impresora()
    if err:
        return jsonify({"status": "error", "message": err}), 400
    data = imp.get_x_report()
    if data is None:
        return jsonify({"status": "error", "message": "Sin respuesta",
                        "printer_status": imp.get_printer_status()}), 502
    return jsonify({"status": "ok", "report": data})


@app.route('/fiscal/report/z', methods=['GET'])
def report_z():
    """Lee (no imprime) el ultimo reporte Z."""
    imp, err = _nueva_impresora()
    if err:
        return jsonify({"status": "error", "message": err}), 400
    data = imp.get_z_report()
    if data is None:
        return jsonify({"status": "error", "message": "Sin respuesta",
                        "printer_status": imp.get_printer_status()}), 502
    return jsonify({"status": "ok", "report": data})


@app.route('/fiscal/report/z-range', methods=['GET'])
def report_z_range():
    """Lee reportes Z por rango. by=number (?start=&end= enteros) o by=date (?start=&end= DDMMYY)."""
    imp, err = _nueva_impresora()
    if err:
        return jsonify({"status": "error", "message": err}), 400
    by = request.args.get("by", "number")
    start = request.args.get("start", "")
    end = request.args.get("end", "")
    if not start or not end:
        return jsonify({"status": "error", "message": "Faltan 'start'/'end'"}), 400
    try:
        if by == "date":
            if not (re.match(r'^\d{6}$', start) and re.match(r'^\d{6}$', end)):
                return jsonify({"status": "error", "message": "Fechas deben ser DDMMYY (6 digitos)"}), 400
            data = imp.get_z_reports_by_date(start, end)
        else:
            data = imp.get_z_reports_by_number(int(start), int(end))
    except ValueError:
        return jsonify({"status": "error", "message": "start/end invalidos"}), 400
    if data is None:
        return jsonify({"status": "error", "message": "Sin respuesta",
                        "printer_status": imp.get_printer_status()}), 502
    return jsonify({"status": "ok", "count": len(data), "reports": data})


@app.route('/fiscal/report/print/x', methods=['POST'])
def print_x():
    imp, err = _nueva_impresora()
    if err:
        return jsonify({"status": "error", "message": err}), 400
    ok = imp.print_x_report()
    return jsonify({"status": "ok" if ok else "error", "acked": ok,
                    "printer_status": imp.get_printer_status() if not ok else None})


@app.route('/fiscal/report/print/z', methods=['POST'])
def print_z():
    imp, err = _nueva_impresora()
    if err:
        return jsonify({"status": "error", "message": err}), 400
    ok = imp.print_z_report()
    return jsonify({"status": "ok" if ok else "error", "acked": ok,
                    "printer_status": imp.get_printer_status() if not ok else None})


@app.route('/fiscal/report/print/z-range', methods=['POST'])
def print_z_range():
    """Imprime reportes Z por rango. body {by:'number'|'date', start, end}."""
    imp, err = _nueva_impresora()
    if err:
        return jsonify({"status": "error", "message": err}), 400
    data = request.get_json() or {}
    by, start, end = data.get("by", "number"), data.get("start"), data.get("end")
    if start is None or end is None:
        return jsonify({"status": "error", "message": "Faltan 'start'/'end'"}), 400
    try:
        if by == "date":
            ok = imp.print_z_reports_by_date(str(start), str(end))
        else:
            ok = imp.print_z_reports_by_number(int(start), int(end))
    except ValueError:
        return jsonify({"status": "error", "message": "start/end invalidos"}), 400
    return jsonify({"status": "ok" if ok else "error", "acked": ok})


@app.route('/fiscal/network/<what>', methods=['GET'])
def fiscal_network(what):
    """Config de red del equipo. what in {ip, cw, url, red, cd} (WM12..15/WD13).

    Port fiel pero SIN validar en hardware; ver TFHKA_PROTOCOLO.md.
    """
    imp, err = _nueva_impresora()
    if err:
        return jsonify({"status": "error", "message": err}), 400
    if what.lower() not in imp.NETWORK_COMMANDS:
        return jsonify({"status": "error", "message": f"Tipo invalido. Use: {list(imp.NETWORK_COMMANDS)}"}), 400
    raw = imp.get_network(what)
    if raw is None:
        return jsonify({"status": "error", "message": "Sin respuesta",
                        "printer_status": imp.get_printer_status()}), 502
    return jsonify({"status": "ok", "what": what.lower(), "cmd": imp.NETWORK_COMMANDS[what.lower()], "raw": raw})


@app.route('/fiscal/fel', methods=['POST'])
def fiscal_fel():
    """Modo FEL/JSON (facturacion electronica, modelos que lo soportan)."""
    imp, err = _nueva_impresora()
    if err:
        return jsonify({"status": "error", "message": err}), 400
    payload = (request.get_json() or {}).get("payload", "")
    if not payload:
        return jsonify({"status": "error", "message": "Falta 'payload'"}), 400
    return jsonify({"status": "ok", "response": imp.send_cmd_fel(payload)})


# --------------------------------------------------------------------------
#  Operaciones "Fijas" (extraídas del Fiscalizador; ver OPERACIONES_FISCALIZADOR.md)
#  Cada operación es una secuencia de comandos. Las fiscales emiten un documento
#  REAL con número consecutivo; fondo/retiro/no-fiscal son movimientos de caja.
# --------------------------------------------------------------------------
_TAX = {0: " ", 1: "!", 2: '"', 3: "#", 4: "$"}


def _n(s, width):
    """Quita la coma decimal y rellena con ceros (formato de montos HKA)."""
    return s.replace(",", "").rjust(width, "0")


def _prod(tasa, precio, cant, desc):
    return f"{_TAX[tasa]}{_n(precio, 10)}{_n(cant, 8)}{desc}"


def _devol(tasa, precio, cant, desc):
    return f"d{tasa}{_n(precio, 10)}{_n(cant, 8)}{desc}"


def _nd_item(tasa, precio, cant, desc):
    return f"`{tasa}{_n(precio, 10)}{_n(cant, 8)}{desc}"


def _pago_parcial(tipo, medio, monto):
    return f"{tipo}{medio}{_n(monto, 12)}"


_CM = "@PRUEBA DESDE TITANIOPOS"

OPERACIONES = {
    "factura-cliente": {"label": "Factura Cliente", "fiscal": True, "lines": [
        "iS*THE FACTORY HKA, C.A.", "iR*J-312171197",
        "i00DIRECCION: LA CALIFORNIA", "i01CARACAS", _CM,
        _prod(0, "0,10", "1,000", "Producto 1"), _prod(1, "0,10", "1,000", "Producto 2"),
        _prod(2, "0,10", "1,000", "Producto 3"), _prod(3, "0,10", "1,000", "Producto 4"),
        _CM, "3", "101", "199"]},
    "factura-igtf": {"label": "Factura IGTF", "fiscal": True, "lines": [
        "iR* J31218119-7", "iS*THE FACTORY HKA, C.A.", _CM,
        " 000000010000001000prueba", "!000000010000001000prueba",
        '"000000010000001000prueba', "#000000010000001000prueba",
        "$000000010000001000prueba", _CM, "124", "199"]},
    "factura-pago-parcial": {"label": "Factura Pago Parcial", "fiscal": True, "lines": [
        "iS*THE FACTORY HKA, C.A.", "iR*J-312171197", "i00DIRECCION: LA CALIFORNIA", "i01CARACAS",
        _prod(0, "0,10", "1,000", "Producto 1"), "p-5000",
        _prod(1, "0,10", "1,000", "Producto 2"), _CM,
        _prod(2, "0,10", "2,000", "Producto 3"), _prod(3, "0,10", "1,000", "Producto 4"),
        "k", _pago_parcial("2", "05", "0,07"), _pago_parcial("2", "09", "0,20"),
        _pago_parcial("2", "13", "0,10"), "101", "199"]},
    "factura-pago-total": {"label": "Factura Pago Total", "fiscal": True, "lines": [
        "iS*THE FACTORY HKA, C.A.", "iR*J-312171197", "i00DIRECCION: LA CALIFORNIA", "i01CARACAS",
        _prod(0, "0,10", "1,000", "Producto 1"), "p-5000",
        _prod(1, "0,10", "1,000", "Producto 2"), _CM,
        _prod(2, "0,10", "1,000", "Producto 3"), _prod(3, "0,10", "2,000", "Producto 4"),
        "k", "101", "199"]},
    "factura-descuento": {"label": "Factura Descuento (p- % y q- monto)", "fiscal": True, "lines": [
        "iS*PRUEBA TITANIOPOS", "iR*J-312171197",
        _prod(1, "10,00", "1,000", "PRODUCTO DESC PORCENTUAL"), "p-1000",
        _prod(1, "10,00", "1,000", "PRODUCTO DESC MONTO"), "q-000000100",
        "3", "101", "199"]},
    "factura-anulacion": {"label": "Factura con Anulación", "fiscal": True, "lines": [
        "i01Juan Pablo Segundo", "i02San jose", "i03 ", "i04 ", "@Producto en Promocion",
        _prod(0, "0,20", "1,000", "Producto 1"), _prod(1, "0,40", "3,000", "Producto 2"),
        _prod(2, "0,10", "5,000", "Producto 3"), "3", "7"]},
    "nota-credito": {"label": "Nota de Crédito", "fiscal": True, "lines": [
        "iS*THE FACTORY HKA, C.A.", "iR*J-312171197", "iF*00001234", "iI*Z7C1234567",
        "iD*09-09-2021", "i00DIRECCION: LA CALIFORNIA", "i01CARACAS",
        _devol(0, "0,10", "1,000", "Producto 1"), _devol(1, "0,10", "1,000", "Producto 2"),
        _devol(2, "0,10", "1,000", "Producto 3"), _devol(3, "0,10", "1,000", "Producto 4"),
        _CM, "101", "199"]},
    "nc-igtf": {"label": "Nota de Crédito IGTF", "fiscal": True, "lines": [
        "iR* J31218119-7", "iS*THE FACTORY HKA, C.A.", "iF* 000000001", "iD* 28/03/2022",
        "iI* Z7C1234567", "d0000000010000001000prueba", "BPRUEBA DESDE TITANIOPOS",
        "d1000000010000001000prueba", "d2000000010000001000prueba", "d3000000010000001000prueba",
        "d4000000010000001000prueba", "BPRUEBA DESDE TITANIOPOS", "124", "199"]},
    "nota-debito": {"label": "Nota de Débito", "fiscal": True, "lines": [
        "iF*00001234", "iD*09-09-2021", "iR*J-312171197", "iS*THE FACTORY HKA, C.A.",
        "iI*Z7C1234567", _nd_item(0, "0,10", "1,000", "PRODUCTO 1"),
        _nd_item(1, "0,10", "1,000", "PRODUCTO 2"), _nd_item(2, "0,10", "1,000", "PRODUCTO 3"),
        _nd_item(3, "0,10", "1,000", "PRODUCTO 4"), _nd_item(4, "0,10", "1,000", "PRODUCTO 5"),
        "BPRUEBA DESDE TITANIOPOS", "101", "199"]},
    # Muestrario de formatos '80x': cada línea sale con un char de formato distinto
    # (fuente/estilo). Sirve para MEDIR cuántas columnas imprime cada fuente (la
    # regla de dígitos) y elegir el formato/ancho del presupuesto sin adivinar.
    "no-fiscal-fuentes": {"label": "Fuentes No Fiscal (80x)", "fiscal": False, "lines": [
        "800FORMATO 0 |123456789012345678901234567890123456789012345678901234567890",
        "801FORMATO 1 |123456789012345678901234567890123456789012345678901234567890",
        "802FORMATO 2 |123456789012345678901234567890123456789012345678901234567890",
        "803FORMATO 3 |123456789012345678901234567890123456789012345678901234567890",
        "804FORMATO 4 |123456789012345678901234567890123456789012345678901234567890",
        "80*FORMATO * |123456789012345678901234567890123456789012345678901234567890",
        "80>FORMATO > |123456789012345678901234567890123456789012345678901234567890",
        "80$FORMATO $ |123456789012345678901234567890123456789012345678901234567890",
        "80!FORMATO ! |123456789012345678901234567890123456789012345678901234567890",
        "810FIN: cuenta los digitos visibles de cada fila"]},
    "documento-no-fiscal": {"label": "Documento No Fiscal", "fiscal": False, "lines": [
        "800Documento de prueba para ejemplificar el uso ",
        "80*de los Documentos NO Fiscales y de sus",
        "80>distintas caracteristicas y efectos.....",
        "80$dichos documentos pueden ser utilizados para",
        "80!la impresion de reportes internos de los Sistemas Adm.",
        "80¡y/o comandas para restaurantes, etc.",
        "810Fin de uso....,,,,,,,,,,"]},
    "fondo-caja": {"label": "Fondo de Caja", "fiscal": False, "lines": [
        "9101000000000100", "t"]},
    "retiro-caja": {"label": "Retiro de Caja", "fiscal": False, "lines": [
        "9001000000000100", "t"]},
}


@app.route('/fiscal/operations', methods=['GET'])
def listar_operaciones():
    """Lista las operaciones de prueba disponibles (para poblar el panel)."""
    return jsonify({"status": "ok", "operations": [
        {"name": k, "label": v["label"], "fiscal": v["fiscal"]}
        for k, v in OPERACIONES.items()]})


@app.route('/fiscal/operation/<name>', methods=['POST'])
def correr_operacion(name):
    """Ejecuta una operación 'Fija' del Fiscalizador. Emite un documento REAL."""
    op = OPERACIONES.get(name)
    if not op:
        return jsonify({"status": "error", "message": f"Operación desconocida: {name}"}), 404
    imp, err = _nueva_impresora()
    if err:
        return jsonify({"status": "error", "message": err}), 400
    # Flujo robusto (recupera doc abierto, ACK+reintento, verifica cierre).
    # lock_fiscal: serializado con la cola — sin esto, esta impresión podía
    # intercalarse entre el print de un job y su lectura de S1 (el job capturaba
    # el número fiscal de ESTE documento en vez del suyo).
    with lock_fiscal:
        diag = imp.print_invoice(op["lines"])
        _log_fiscal_attempt(f"op:{name}", None, diag)
        # El S1 va DENTRO del lock: debe corresponder a ESTE documento.
        s1_op = None
        try:
            s1_op = imp.get_s1_data()
        except Exception:
            s1_op = None
    # warn_tail_failed / warn_close_ack_lost = el documento SÍ cerró (solo falló
    # una línea posterior o el ACK llegó tarde): éxito con aviso, no error.
    cerro_ok = diag.get("ok") and diag.get("reason") in (None, "warn_tail_failed", "warn_close_ack_lost")
    if cerro_ok:
        msg = f"{op['label']}: procesada correctamente"
        if diag.get("reason"):
            msg += f" (aviso: {diag.get('reason')})"
        if diag.get("recovered_open_doc"):
            msg += " (se canceló un documento abierto previo)"
    elif diag.get("ok") and diag.get("reason") == "warn_not_closed":
        msg = f"{op['label']}: salió pero la impresora no confirmó el cierre"
    else:
        msg = f"{op['label']}: {_mensaje_fallo_impresion(diag)}"

    # S1 leído tras imprimir: serial de la máquina + número fiscal asignado al documento.
    maquina = None
    numero_fiscal = None
    try:
        s1 = s1_op
        if s1:
            maquina = {
                "serial": s1.get("registered_machine_number"),
                "rif": s1.get("rif"),
                "ultima_factura": s1.get("last_invoice_number"),
                "ultima_nota_credito": s1.get("last_credit_note_number"),
                "ultima_nota_debito": s1.get("last_debit_note_number"),
                "ultimo_no_fiscal": s1.get("last_non_fiscal_doc_number"),
                "fecha_hora": s1.get("current_printer_datetime"),
            }
            # El "número fiscal" del documento depende del tipo de operación.
            if name in ("nota-credito", "nc-igtf"):
                numero_fiscal = maquina["ultima_nota_credito"]
            elif name == "nota-debito":
                numero_fiscal = maquina["ultima_nota_debito"]
            elif name == "documento-no-fiscal":
                numero_fiscal = maquina["ultimo_no_fiscal"]
            elif name.startswith("factura"):
                numero_fiscal = maquina["ultima_factura"]
    except Exception:
        pass

    return jsonify({"status": "ok" if cerro_ok else "error", "message": msg,
                    "operation": name, "label": op["label"], "diagnostico": diag,
                    "printer_status": diag.get("post_status") or diag.get("pre_status"),
                    "machine": maquina, "numero_fiscal": numero_fiscal})


# --------------------------------------------------------------------------
#  Endpoints: configuracion / pruebas / salud
# --------------------------------------------------------------------------
@app.route('/fiscal/config', methods=['GET'])
def obtener_config():
    return jsonify({"base_dir": BASE_DIR, "data_dir": DATA_DIR, "runtime_dir": RUNTIME_DIR,
                    "archivo_factura": get_factura_path(), "archivo_puerto": get_puerto_dat_path(),
                    "puerto_com": leer_puerto_com(), "archivo_ids": ARCHIVO_IDS_EJECUTADOS,
                    "puerto_servidor": PUERTO, "backend": "tfhka"})


@app.route('/fiscal/config/puerto', methods=['POST'])
def configurar_puerto():
    try:
        puerto = (request.get_json() or {}).get("puerto", "")
        if not puerto:
            return jsonify({"status": "error", "message": "Puerto no especificado"}), 400
        if not puerto.upper().startswith("COM"):
            return jsonify({"status": "error", "message": "Formato invalido. Use COM1, COM2, etc."}), 400
        if configurar_puerto_com(puerto.upper()):
            return jsonify({"status": "ok", "message": f"Puerto {puerto.upper()} configurado",
                            "puerto_com": puerto.upper(), "archivo_puerto": get_puerto_dat_path()})
        return jsonify({"status": "error", "message": "Error al escribir Puerto.dat"}), 500
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/fiscal/config/puerto', methods=['GET'])
def obtener_puerto():
    return jsonify({"status": "ok", "puerto_com": leer_puerto_com(), "archivo_puerto": get_puerto_dat_path()})


@app.route('/fiscal/test-printer', methods=['POST'])
def test_printer():
    imp, err = _nueva_impresora()
    if err:
        return jsonify({"status": "error", "message": err + ". Configure Puerto.dat primero."}), 400
    conectada = imp.check_fprinter()
    return jsonify({"status": "ok" if conectada else "error",
                    "message": "Impresora conectada" if conectada else "Impresora no detectada",
                    "printer_connected": conectada, "puerto_com": imp.port, "method": "tfhka",
                    "error": imp.last_error if not conectada else None})


@app.route('/fiscal/test-print', methods=['POST'])
def test_print():
    """Imprime una factura de prueba: 1 producto exento de 1 Bs, pago efectivo.
    OJO: genera un documento fiscal REAL con numero consecutivo."""
    imp, err = _nueva_impresora()
    if err:
        return jsonify({"status": "error", "message": err}), 400
    test_uuid = str(uuid.uuid4())
    short_id = test_uuid.split('-')[-1]
    # Formato HKA80: [TaxCode 1][Price 10][Qty 8][Desc <=20]
    tax, price, qty = " ", "0000000100", "00001000"
    desc = f"PRUEBA {short_id}"[:20]
    lineas = [f"i05Caja: TEST-{short_id[:8]}", f"{tax}{price}{qty}{desc}", "101"]

    # Flujo robusto: recupera un documento abierto de un intento previo (causa del
    # "1ra incompleta / 2da completa"), envía con ACK+reintento y CONFIRMA el cierre.
    # lock_fiscal: serializado con la cola de facturas reales.
    with lock_fiscal:
        diag = imp.print_invoice(lineas)
    _log_fiscal_attempt("test-print", f"TEST-{short_id[:8]}", diag)

    # Éxito real = imprimió Y cerró (cortó). warn_not_closed => salió pero no cerró.
    # warn_close_ack_lost => cerró (el ACK del pago llegó tarde, verificado por status).
    cerro_ok = diag.get("ok") and diag.get("reason") in (None, "warn_close_ack_lost")
    if cerro_ok:
        msg = f"Factura de prueba impresa y cerrada (UUID: {short_id})"
        if diag.get("recovered_open_doc"):
            msg += ". Se canceló un documento abierto previo antes de imprimir."
    elif diag.get("ok") and diag.get("reason") == "warn_not_closed":
        msg = ("La prueba salió pero la impresora NO confirmó el cierre del documento "
               "(quedó en transacción). Revisa que no haya otro programa usando el puerto "
               "COM (p.ej. el Fiscalizador oficial abierto).")
    else:
        msg = _mensaje_fallo_impresion(diag)

    return jsonify({"status": "ok" if cerro_ok else "error", "message": msg,
                    "method": "tfhka", "uuid": test_uuid, "diagnostico": diag,
                    "printer_status": diag.get("post_status") or diag.get("pre_status")})


@app.route('/fiscal/ids-ejecutados', methods=['GET'])
def obtener_ids_ejecutados():
    return jsonify({"ids_ejecutados": list(ids_caja_ejecutados), "total": len(ids_caja_ejecutados)})


@app.route('/fiscal/ids-ejecutados', methods=['DELETE'])
def limpiar_ids_ejecutados():
    global ids_caja_ejecutados
    try:
        ids_caja_ejecutados.clear()
        with open(ARCHIVO_IDS_EJECUTADOS, 'w') as f:
            f.write("")
        return jsonify({"status": "ok", "message": "IDs ejecutados limpiados"})
    except Exception as e:
        return jsonify({"status": "error", "message": f"Error limpiando IDs: {e}"}), 500


@app.route('/health', methods=['GET'])
def health_check():
    return jsonify({"status": "ok", "timestamp": datetime.now().isoformat(),
                    "backend": "tfhka", "puerto_com": leer_puerto_com()})


# --------------------------------------------------------------------------
#  Arranque
# --------------------------------------------------------------------------
threading.Thread(target=procesar_cola_fiscal, daemon=True).start()


def limpieza_periodica_duplicados():
    while True:
        try:
            time.sleep(60)
            limpiar_peticiones_expiradas()
        except Exception as e:
            print(f"Error en limpieza periodica: {e}")


threading.Thread(target=limpieza_periodica_duplicados, daemon=True).start()
cargar_ids_ejecutados()

if __name__ == '__main__':
    print("=== Servidor Fiscal TitanioPOS (backend tfhka) ===")
    print(f"Runtime Dir: {RUNTIME_DIR}")
    print(f"Puerto COM: {leer_puerto_com()}")
    print(f"Puerto servidor: {PUERTO}")
    print("==================================================")
    app.run(host='0.0.0.0', port=PUERTO)
