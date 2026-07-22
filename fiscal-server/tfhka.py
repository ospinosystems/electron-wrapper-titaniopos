"""
tfhka.py - Port fiel en Python del SDK TfhkaNet.dll (The Factory HKA, Venezuela).

Reemplaza a hka_serial.py y a IntTFHKA.exe: implementa el protocolo serial
completo (framing STX/ETX/LRC, maquina de recepcion por tramas, ACK/NAK,
handshake ENQ->ACK para reportes) y el catalogo de comandos de la interfaz VE,
incluyendo la LECTURA de las respuestas de la impresora (status, reportes X/Z,
datos S1..S8, etc.).

Referencia: descompilacion de
  TfhkaNet.IF.TfhkaSerialPortControl   (framing y transporte)
  TfhkaNet.IF.TfhkaCommon               (SendCmd, ReadFpStatus, SubirData*)
  TfhkaNet.IF.VE.Tfhka                  (comandos U*/I*/S* de Venezuela)
  TfhkaNet.IF.VE.ReportData / S1PrinterData / Utilities

NOTA DE HARDWARE (validar en caja real):
  - El SDK abre el puerto con paridad PAR (8E1). El hka_serial.py previo, validado
    contra hardware real, usaba SIN paridad (8N1) y funcionaba. Por eso el default
    aqui es 8N1; se puede forzar 8E1 con FISCAL_PARITY=E.
  - El protocolo NO usa byte de secuencia (SEQ): la trama es STX+CMD+ETX+LRC.
"""

import os
import time
import socket
import threading

import serial

# --- Caracteres de control del protocolo (TfhkaSerialPortControl) ---
STX = 0x02  # inicio de trama
ETX = 0x03  # fin de trama (ultimo bloque)
EOT = 0x04  # fin de transmision
ENQ = 0x05  # enquiry / "listo para enviar data"
ACK = 0x06  # confirmacion
SO = 0x0E
NAK = 0x15  # rechazo
ETB = 0x17  # fin de bloque intermedio (viene mas data)
IJSON = ord('[')
EJSON = ord(']')

ENCODING = 'iso-8859-15'  # LATIN9, el que usa el SDK

# Estados con un documento fiscal/no-fiscal ABIERTO (descripción "...Transaction",
# no "...Waiting"). Si la impresora está aquí ANTES de imprimir, quedó un
# documento a medias de un intento previo (causa clásica de Error 128 en cadena).
_IN_TRANSACTION = {"02", "03", "05", "06", "08", "09", "11", "12"}

# Flask es multi-threaded; el puerto serial no se comparte entre threads.
_SERIAL_LOCK = threading.RLock()


def _parity_from_env():
    """Paridad configurable. Default N (8N1, validado en hardware). E fuerza 8E1 (default del SDK)."""
    p = os.environ.get('FISCAL_PARITY', 'N').strip().upper()
    if p in ('E', 'EVEN'):
        return serial.PARITY_EVEN
    if p in ('O', 'ODD'):
        return serial.PARITY_ODD
    return serial.PARITY_NONE


def do_xor(cmd):
    """LRC del comando: XOR de todos los bytes del comando, luego XOR con ETX.

    Equivale a Do_XOR() del SDK: XOR(cmd) ^ ETX. Trabajamos en bytes para evitar
    el remapeo unicode de iso-8859-15 que hace el original al re-encodear el char.
    """
    if isinstance(cmd, str):
        cmd = cmd.encode(ENCODING)
    lrc = 0
    for b in cmd:
        lrc ^= b
    return lrc ^ ETX


def to_double(buf):
    """Numero real de la impresora: los ultimos 2 digitos son centavos.

    Port de Utilities.ToDouble: "12345" -> 123.45 ; "-12345" -> -123.45.
    """
    try:
        buf = buf.strip()
        if len(buf) < 3:
            return float(buf) if buf else 0.0
        entero = float(buf[:-2])
        centavos = float(buf[-2:]) / 100.0
        return entero - centavos if entero < 0 else entero + centavos
    except (ValueError, TypeError):
        return 0.0


# ---------------------------------------------------------------------------
#  Decodificador de status/error  (DarStatus_Error)
# ---------------------------------------------------------------------------
def dar_status_error(st, er):
    """Traduce los bytes STS/ERR a los codigos estandar TFHKA.

    Port literal de DarStatus_Error(). Devuelve dict con status/error numericos,
    sus descripciones y si el error es "valido" (recuperable, p.ej. sin papel).
    """
    num = st
    st &= ~0x04  # st &= -5: limpia bit 2

    status, descrip_status = "00", "Unknown Status"
    if (st & 0xE2) == 0xE2:
        status, descrip_status = "14", "In Fiscal Mode, in Non Fiscal Transaction and Blocked by Annual Technical Inspection"
    elif (st & 0xE0) == 0xE0:
        status, descrip_status = "13", "In Fiscal Mode and Blocked by Annual Technical Inspection"
    elif (st & 0x6A) == 0x6A:
        status, descrip_status = "12", "In Fiscal Mode, Memory Full, in Non Fiscal Transaction"
    elif (st & 0x69) == 0x69:
        status, descrip_status = "11", "In Fiscal Mode, Memory Full, in Fiscal Transaction"
    elif (st & 0x68) == 0x68:
        status, descrip_status = "10", "In Fiscal Mode Memory Full and Waiting"
    elif (st & 0x72) == 0x72:
        status, descrip_status = "09", "In Fiscal Mode, Fiscal Memory Almost Full, in Non Fiscal Transaction"
    elif (st & 0x71) == 0x71:
        status, descrip_status = "08", "In Fiscal Mode, Fiscal Memory Almost Full, in Fiscal Transaction"
    elif (st & 0x70) == 0x70:
        status, descrip_status = "07", "In Fiscal Mode, Fiscal Memory Almost Full and Wait"
    elif (st & 0x62) == 0x62:
        status, descrip_status = "06", "In Fiscal Mode, in Non Fiscal Transaction"
    elif (st & 0x61) == 0x61:
        status, descrip_status = "05", "In Fiscal Mode, in Fiscal Transaction"
    elif (st & 0x60) == 0x60:
        status, descrip_status = "04", "In Fiscal Mode and Waiting"
    elif (st & 0x42) == 0x42:
        status, descrip_status = "03", "In Non Fiscal Mode, in Non Fiscal Transaction"
    elif (st & 0x41) == 0x41:
        status, descrip_status = "02", "In Non Fiscal Mode, in Fiscal Transaction"
    elif (st & 0x40) == 0x40:
        status, descrip_status = "01", "In Non Fiscal Mode and Waiting"

    error, descrip_error, error_valid = "00", "No Error", True
    if (er & 0x6C) == 0x6C:
        error, descrip_error, error_valid = "108", "Fiscal Memory Full", False
    elif (er & 0x64) == 0x64:
        error, descrip_error, error_valid = "100", "Fiscal Memory Error", False
    elif (er & 0x60) == 0x60:
        error, descrip_error, error_valid = "96", "Fiscal Error", False
    elif (er & 0x5C) == 0x5C:
        error, descrip_error, error_valid = "92", "Invalid Command", False
    elif (er & 0x58) == 0x58:
        error, descrip_error, error_valid = "88", "No Directives Assigned", False
    elif (er & 0x54) == 0x54:
        error, descrip_error, error_valid = "84", "Invalid Tax", False
    elif (er & 0x50) == 0x50:
        error, descrip_error, error_valid = "80", "Command Invalid / Invalid Value", False
    elif (er & 0x43) == 0x43:
        error, descrip_error, error_valid = "03", "End of Paper and/or Mechanic Error", True
    elif (er & 0x42) == 0x42:
        error, descrip_error, error_valid = "02", "Mechanic Error with Paper", True
    elif (er & 0x41) == 0x41:
        error, descrip_error, error_valid = "01", "End of Paper", True
    elif (er & 0x40) == 0x40:
        error, descrip_error, error_valid = "00", "No Error", True

    if (num & 0x04) == 0x04:
        error, descrip_error, error_valid = "112", "Buffer Full", False
    else:
        especiales = {
            128: ("128", "Communication Error"),
            137: ("137", "No Answer"),
            144: ("144", "LRC Error"),
            145: ("145", "Intern API Error"),
            153: ("153", "Opening File Error"),
            71: ("71", "No paper detected"),
        }
        if er in especiales:
            error, descrip_error = especiales[er]
            error_valid = False

    return {
        "status": status,
        "status_description": descrip_status,
        "error": error,
        "error_description": descrip_error,
        "error_valid": error_valid,
    }


# ---------------------------------------------------------------------------
#  Parsers de respuesta (rescatar la data de la fiscal)
# ---------------------------------------------------------------------------
def _fecha(campo6):
    """AAMMDD (6 chars) -> (anio, mes, dia). Maneja el caso 000000 del SDK."""
    aa = int(campo6[0:2]) + 2000
    mm = int(campo6[2:4])
    dd = int(campo6[4:6])
    if mm == 0 and dd == 0 and aa == 2000:
        return 1, 1, 1
    return aa, mm, dd


def parse_report_data(trama):
    """Port de VE.ReportData: reporte X/Z. Layout por cantidad de campos (\\n)."""
    if not trama:
        return None
    campos = trama.split('\n')
    n = len(campos)
    r = {"raw": trama, "layout_fields": n}
    try:
        r["number_of_last_z_report"] = int(campos[0])
        if n in (21, 22):
            aa, mm, dd = _fecha(campos[1])
            if n == 21:
                r["z_report_date"] = f"{dd:02d}/{mm:02d}/{aa}"
                r["number_of_last_invoice"] = int(campos[2])
                aa2, mm2, dd2 = _fecha(campos[3])
                r["last_invoice_date"] = f"{dd2:02d}/{mm2:02d}/{aa2} {campos[4][0:2]}:{campos[4][2:4]}"
                base = 5
            else:  # 22
                r["z_report_date"] = f"{dd:02d}/{mm:02d}/{aa} {campos[2][0:2]}:{campos[2][2:4]}"
                r["number_of_last_invoice"] = int(campos[3])
                aa2, mm2, dd2 = _fecha(campos[4])
                r["last_invoice_date"] = f"{dd2:02d}/{mm2:02d}/{aa2} {campos[5][0:2]}:{campos[5][2:4]}"
                base = 6
            claves = [
                "free_sales_tax", "general_rate1_sale", "general_rate1_tax",
                "reduced_rate2_sale", "reduced_rate2_tax", "additional_rate3_sale",
                "additional_rate3_tax", "free_tax_devolution", "general_rate_devolution",
                "general_rate_tax_devolution", "reduced_rate_devolution",
                "reduced_rate_tax_devolution", "additional_rate_devolution",
                "additional_rate_tax_devolution",
            ]
            for i, k in enumerate(claves):
                r[k] = to_double(campos[base + i])
            r["number_of_last_credit_note"] = int(campos[base + 14])
        else:
            # Layouts 34 / 40 / default (>=30): con debito/percibido/IGTF
            aa, mm, dd = _fecha(campos[1])
            r["z_report_date"] = f"{dd:02d}/{mm:02d}/{aa} {campos[2][0:2]}:{campos[2][2:4]}"
            r["number_of_last_invoice"] = int(campos[3])
            aa2, mm2, dd2 = _fecha(campos[4])
            r["last_invoice_date"] = f"{dd2:02d}/{mm2:02d}/{aa2} {campos[5][0:2]}:{campos[5][2:4]}"
            r["number_of_last_debit_note"] = int(campos[6])
            r["number_of_last_credit_note"] = int(campos[7])
            r["number_of_last_non_fiscal"] = int(campos[8])
            claves = [
                "free_sales_tax", "general_rate1_sale", "general_rate1_tax",
                "reduced_rate2_sale", "reduced_rate2_tax", "additional_rate3_sale",
                "additional_rate3_tax", "free_tax_debit", "general_rate_debit",
                "general_rate_tax_debit", "reduced_rate_debit", "reduced_rate_tax_debit",
                "additional_rate_debit", "additional_rate_tax_debit", "free_tax_devolution",
                "general_rate_devolution", "general_rate_tax_devolution",
                "reduced_rate_devolution", "reduced_rate_tax_devolution",
                "additional_rate_devolution", "additional_rate_tax_devolution",
            ]
            for i, k in enumerate(claves):
                r[k] = to_double(campos[9 + i])
            if n >= 33:
                r["percibido_rate_sales"] = to_double(campos[30])
                r["percibido_rate_debit"] = to_double(campos[31])
                r["percibido_rate_devolution"] = to_double(campos[32])
            if n >= 40:
                r["igtf_rate_sales"] = to_double(campos[33])
                r["igtf_rate_tax_sales"] = to_double(campos[34])
                r["igtf_rate_debit"] = to_double(campos[35])
                r["igtf_rate_tax_debit"] = to_double(campos[36])
                r["igtf_rate_devolution"] = to_double(campos[37])
                r["igtf_rate_tax_devolution"] = to_double(campos[38])
    except (ValueError, IndexError):
        pass
    return r


def parse_s1(trama):
    """Port de VE.S1PrinterData: datos de la maquina (RIF, serial, contadores)."""
    if not trama:
        return None
    r = {"raw": trama}
    campos = trama.split('\n')
    try:
        if len(trama) < 116:
            if len(campos) >= 12:
                r["cashier_number"] = int(campos[0][2:])
                r["total_daily_sales"] = to_double(campos[1])
                r["last_invoice_number"] = int(campos[2])
                r["quantity_of_invoices_today"] = int(campos[3])
                r["last_non_fiscal_doc_number"] = int(campos[4])
                r["quantity_non_fiscal_documents"] = int(campos[5])
                r["daily_closure_counter"] = int(campos[6])
                r["audit_reports_counter"] = int(campos[7])
                r["rif"] = campos[8]
                r["registered_machine_number"] = campos[9]
                r["current_printer_datetime"] = _fmt_dt(campos[10], campos[11])
                if len(campos) >= 14:
                    r["last_credit_note_number"] = int(campos[12])
                    r["quantity_of_credit_notes_today"] = int(campos[13])
                else:
                    r["last_credit_note_number"] = 0
                    r["quantity_of_credit_notes_today"] = 0
        else:
            if len(campos) >= 16:
                r["cashier_number"] = int(campos[0][2:])
                r["total_daily_sales"] = to_double(campos[1])
                r["last_invoice_number"] = int(campos[2])
                r["quantity_of_invoices_today"] = int(campos[3])
                r["last_debit_note_number"] = int(campos[4])
                r["quantity_of_debit_notes_today"] = int(campos[5])
                r["last_credit_note_number"] = int(campos[6])
                r["quantity_of_credit_notes_today"] = int(campos[7])
                r["last_non_fiscal_doc_number"] = int(campos[8])
                r["quantity_non_fiscal_documents"] = int(campos[9])
                r["audit_reports_counter"] = int(campos[10])
                r["daily_closure_counter"] = int(campos[11])
                r["rif"] = campos[12]
                r["registered_machine_number"] = campos[13]
                r["current_printer_datetime"] = _fmt_dt(campos[14], campos[15])
    except (ValueError, IndexError):
        pass
    return r


def _fmt_dt(hms, dmy):
    """hms=HHMMSS, dmy=DDMMYY -> 'DD/MM/YYYY HH:MM:SS'."""
    try:
        return (f"{dmy[0:2]}/{dmy[2:4]}/{int(dmy[4:6]) + 2000} "
                f"{hms[0:2]}:{hms[2:4]}:{hms[4:6]}")
    except (ValueError, IndexError):
        return None


# ---------------------------------------------------------------------------
#  Clase de comunicacion
# ---------------------------------------------------------------------------
class Tfhka:
    """Interfaz con la impresora fiscal (serial o TCP). Un objeto por operacion."""

    def __init__(self, port='COM6', baudrate=9600, timeout=8):
        self.port = port
        self.baudrate = baudrate
        self.timeout = timeout          # timeout de recepcion por defecto (s)
        self.serial = None
        self.last_error = ""
        self.retry_attempts = 5         # SendCmd: reintentos en NAK/timeout
        self.retry_interval = 0.3       # s entre reintentos (SDK usa 10s; aca practico)
        # Modo TCP (config.txt: IPADDRESS/PORT). None = serial.
        self.tcp = self._leer_config_tcp()

    # ---- configuracion TCP (LeerArchivoServidorTcp) ----
    def _leer_config_tcp(self):
        try:
            cfg = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.txt')
            if not os.path.exists(cfg):
                return None
            ip, puerto = '', 0
            with open(cfg, 'r', encoding='utf-8', errors='ignore') as f:
                for line in f:
                    if 'IPADDRESS=' in line:
                        ip = line.split('IPADDRESS=', 1)[1].strip()
                    elif 'PORT=' in line:
                        try:
                            puerto = int(line.split('PORT=', 1)[1].strip())
                        except ValueError:
                            puerto = 0
            if ip and puerto:
                return (ip, puerto)
        except Exception:
            pass
        return None

    # ---- apertura / cierre (OpenFpCtrl / CloseFpCtrl) ----
    def open(self):
        if self.tcp:
            return True  # TCP abre/cierra por mensaje
        try:
            if self.serial and self.serial.is_open:
                return True
            self.serial = serial.Serial(
                port=self.port,
                baudrate=self.baudrate,
                bytesize=serial.EIGHTBITS,
                parity=_parity_from_env(),
                stopbits=serial.STOPBITS_ONE,
                timeout=0,               # no-bloqueante: leemos con deadline propio
                write_timeout=4,
            )
            return True
        except Exception as e:
            self.last_error = str(e)
            return False

    def close(self):
        try:
            if self.serial and self.serial.is_open:
                self.serial.close()
        except Exception:
            pass

    # ---- transporte (SerialPortWriteAndRead + maquina de recepcion) ----
    def _write_and_read(self, data, timeout=None):
        """Escribe bytes crudos y lee una trama de respuesta. Devuelve bytes."""
        if timeout is None:
            timeout = self.timeout
        if self.tcp:
            return self._tcp_send(data, timeout)
        try:
            self.serial.reset_input_buffer()
            self.serial.reset_output_buffer()
            self.serial.write(data)
            self.serial.flush()
            return self._read_frame(timeout)
        except Exception as e:
            self.last_error = str(e)
            return b''

    def _tcp_send(self, data, timeout):
        """EnviarMensajeServidorTcp: abre socket, envia, recibe, cierra."""
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(timeout)
            s.connect(self.tcp)
            s.sendall(data)
            resp = s.recv(51200)
            s.close()
            return resp or b''
        except Exception as e:
            self.last_error = str(e)
            return b''

    def _read_frame(self, timeout):
        """Maquina de recepcion (SerialPortReceiveEvent).

        Reconoce: bytes sueltos ACK/NAK/ENQ/EOT; tramas STX..ETX+LRC / STX..ETB+LRC;
        y JSON [..]. Devuelve los bytes de la trama (incluye STX y LRC).
        """
        deadline = time.time() + timeout
        buf = bytearray()
        state = 'ESPERA'
        while time.time() < deadline:
            n = self.serial.in_waiting
            if n == 0:
                time.sleep(0.005)
                continue
            for b in self.serial.read(n):
                if state == 'ESPERA':
                    if b == STX or b == IJSON:
                        buf = bytearray([b])
                        state = 'RECIBIENDO'
                    elif b in (ACK, NAK, ENQ, EOT):
                        return bytes([b])
                    # cualquier otro byte se descarta (basura previa)
                else:  # RECIBIENDO
                    buf.append(b)
                    if b == EOT:
                        return bytes(buf)
                    if len(buf) >= 2 and (buf[-2] == ETX or buf[-2] == ETB):
                        return bytes(buf)  # buf[-1] es el LRC recien leido
                    if b == EJSON:
                        return bytes(buf)
        return bytes(buf)  # timeout: trama parcial o vacia

    # ---- framing de comando (Do_XOR + SerialPortWriteAndRead) ----
    def _build_packet(self, cmd):
        if isinstance(cmd, str):
            # errors='replace': un caracter fuera de latin-9 (comilla tipografica,
            # guion largo, emoji — frecuentes en textos pegados de Excel/web) NO
            # debe reventar con UnicodeEncodeError a mitad de un documento fiscal
            # abierto; se imprime '?' en su lugar.
            cmd_bytes = cmd.encode(ENCODING, errors='replace')
        else:
            cmd_bytes = cmd
        return bytes([STX]) + cmd_bytes + bytes([ETX, do_xor(cmd_bytes)])

    def _send_frame_and_read(self, cmd, timeout=None):
        """SendCmd_Archivos: envia STX+cmd+ETX+LRC y devuelve la trama de respuesta."""
        return self._write_and_read(self._build_packet(cmd), timeout)

    # ---- API de alto nivel ----
    def check_fprinter(self):
        """ENQ -> espera trama de status (>=5 bytes). True si la impresora responde."""
        with _SERIAL_LOCK:
            if not self.open():
                return False
            try:
                resp = self._write_and_read(bytes([ENQ]), timeout=2)
                if len(resp) < 5:
                    resp = self._write_and_read(bytes([ENQ]), timeout=2)
                return len(resp) >= 5
            finally:
                self.close()

    def _read_status_locked(self):
        """Lee status asumiendo puerto ABIERTO y lock tomado (uso interno)."""
        try:
            resp = self._write_and_read(bytes([ENQ]), timeout=2)
            if len(resp) < 5:
                resp = self._write_and_read(bytes([ENQ]), timeout=2)
            if len(resp) >= 5:
                sts, err, lrc = resp[1], resp[2], resp[4]
                if (sts ^ err ^ ETX) != lrc:
                    return dar_status_error(0, 144)  # LRC error
                return dar_status_error(sts, err)
            return dar_status_error(0, 137)  # no answer
        except Exception as e:
            self.last_error = str(e)
            return dar_status_error(0, 128)  # communication error

    def read_fp_status(self):
        """ENQ -> STS/ERR -> dar_status_error. Devuelve dict de status o None."""
        with _SERIAL_LOCK:
            if not self.open():
                return None
            try:
                return self._read_status_locked()
            finally:
                self.close()

    def get_printer_status(self):
        """Alias estructurado de read_fp_status (GetPrinterStatus)."""
        st = self.read_fp_status()
        if st is None:
            st = dar_status_error(48, 128)
        return st

    def check_drawer(self):
        """ENQ -> bit 3 (0x08) del byte ERR = gaveta abierta."""
        with _SERIAL_LOCK:
            if not self.open():
                return False
            try:
                resp = self._write_and_read(bytes([ENQ]), timeout=2)
                if len(resp) >= 5:
                    return (resp[2] & 0x08) == 0x08
                return False
            finally:
                self.close()

    def send_cmd(self, cmd, _keep_open=False):
        """SendCmd: envia comando y espera ACK. Reintenta en NAK/timeout.

        Devuelve True si la impresora confirmo (ACK).
        """
        own = not _keep_open
        with _SERIAL_LOCK:
            if own and not self.open():
                return False
            try:
                packet = self._build_packet(cmd)
                resp = self._write_and_read(packet)
                attempt = 0
                while ((not resp or resp[0] == NAK) and attempt < self.retry_attempts):
                    time.sleep(self.retry_interval)
                    resp = self._write_and_read(packet)
                    attempt += 1
                return len(resp) == 1 and resp[0] == ACK
            finally:
                if own:
                    self.close()

    def send_file(self, filepath):
        """SendFileCmd: envia una factura linea por linea (cada linea es un SendCmd)."""
        with _SERIAL_LOCK:
            if not os.path.exists(filepath):
                self.last_error = f"Archivo no encontrado: {filepath}"
                return False, self.last_error
            if not self.open():
                return False, self.last_error
            try:
                enviadas = []
                with open(filepath, 'r', encoding=ENCODING) as f:
                    for line in f:
                        line = line.rstrip('\r\n')
                        if not line.strip():
                            continue
                        ok = self.send_cmd(line, _keep_open=True)
                        enviadas.append({"line": line, "ok": ok})
                        if not ok:
                            return False, {"linea_fallida": line, "enviadas": enviadas}
                return True, enviadas
            finally:
                self.close()

    def send_lines(self, lines):
        """Como send_file pero desde una lista en memoria."""
        with _SERIAL_LOCK:
            if not self.open():
                return False, self.last_error
            try:
                enviadas = []
                for line in lines:
                    line = str(line).rstrip('\r\n')
                    if not line.strip():
                        continue
                    ok = self.send_cmd(line, _keep_open=True)
                    enviadas.append({"line": line, "ok": ok})
                    if not ok:
                        return False, {"linea_fallida": line, "enviadas": enviadas}
                return True, enviadas
            finally:
                self.close()

    def print_non_fiscal(self, text_lines):
        """Imprime un DOCUMENTO NO FISCAL (presupuesto / comprobante interno).

        Protocolo TFHKA REAL (extraído de Fiscalizador_VE.exe, button9_Click):
          - Cada línea de texto se envía como  "80" + <char de formato> + <texto>.
            La PRIMERA línea "80..." abre el documento no fiscal implícitamente.
          - La ÚLTIMA línea se envía como  "81" + <char de formato> + <texto>:
            el comando 81 imprime la última línea Y CIERRA el documento.
          - NO existe un "80" de apertura suelto ni un "82" de cierre: eso hacía que
            cada "81<texto>" abriera+cerrara un mini-documento (las mini-facturas).
        Char de formato: '0' = normal (el que usa el propio Fiscalizador). NO asigna
        número fiscal ni toca la memoria fiscal — es texto libre (apto para presupuesto).

        Reusa el patrón de print_invoice: recupera un doc abierto de un intento previo,
        valida papel/comunicación, envía con ACK y cancela el parcial si una línea falla.
        """
        with _SERIAL_LOCK:
            if not self.open():
                return {"ok": False, "reason": "open_failed", "error": self.last_error}
            try:
                pre = self._read_status_locked()
                recovered = False
                if pre and pre.get("status") in _IN_TRANSACTION:
                    self.send_cmd("7", _keep_open=True)  # cancela doc abierto previo
                    recovered = True
                    pre = self._read_status_locked()
                if pre and pre.get("error") in ("128", "137"):
                    return {"ok": False, "reason": "no_response", "pre_status": pre,
                            "recovered_open_doc": recovered}
                if pre and pre.get("error") in ("01", "03"):
                    return {"ok": False, "reason": "no_paper", "pre_status": pre,
                            "recovered_open_doc": recovered}

                lines_clean = [str(ln).rstrip("\r\n") for ln in text_lines]
                if not lines_clean:
                    lines_clean = [" "]  # se necesita al menos una línea para cerrar con 81
                seq = []
                n = len(lines_clean)
                for idx, t in enumerate(lines_clean):
                    # "80" imprime/abre; "81" en la ÚLTIMA línea imprime y CIERRA. '0' = formato normal.
                    # Truncar a 64 (no 40): el [:40] recortaba el layout del POS y el
                    # presupuesto salía angosto aunque el papel admite más columnas.
                    prefix = "81" if idx == n - 1 else "80"
                    seq.append(prefix + "0" + t[:64])

                sent = []
                for line in seq:
                    ok = self.send_cmd(line, _keep_open=True)
                    sent.append({"line": line, "ok": ok})
                    if not ok:
                        self.send_cmd("7", _keep_open=True)  # cancela el parcial
                        return {"ok": False, "reason": "nak_line", "line": line,
                                "sent": sent, "pre_status": pre, "recovered_open_doc": recovered}

                post = self._read_status_locked()
                return {"ok": True, "reason": None, "sent": sent, "pre_status": pre,
                        "post_status": post, "recovered_open_doc": recovered}
            finally:
                self.close()

    def print_invoice(self, lines):
        """Imprime una factura/nota en UNA sola sesión de puerto, con diagnóstico.

        Ataca el fallo intermitente silencioso del backend viejo:
        1. Pre-flight: si la impresora quedó con un documento ABIERTO de un intento
           previo (causa clásica de Error 128 en cadena), lo cancela y arranca limpio.
        2. Falla claro si la impresora no responde (128/137) o no tiene papel (01/03),
           en vez de mandar una factura condenada.
        3. Envía línea por línea con ACK+reintento; si una falla, cancela el
           documento parcial y reporta la línea exacta.
        4. Post-flight: lee el estado final para confirmar el cierre (diagnóstico).

        Devuelve un dict con: ok, reason, sent (por línea), pre_status, post_status,
        recovered_open_doc, line (si falló). NUNCA marca éxito en silencio.
        """
        with _SERIAL_LOCK:
            if not self.open():
                return {"ok": False, "reason": "open_failed", "error": self.last_error}
            try:
                pre = self._read_status_locked()
                recovered = False
                # 1. Documento abierto de antes -> cancelar y re-leer.
                if pre and pre.get("status") in _IN_TRANSACTION:
                    self.send_cmd("7", _keep_open=True)
                    recovered = True
                    pre = self._read_status_locked()
                # 2. Guard de comunicación / papel (errores no recuperables para imprimir).
                if pre and pre.get("error") in ("128", "137"):
                    return {"ok": False, "reason": "no_response", "pre_status": pre,
                            "recovered_open_doc": recovered}
                if pre and pre.get("error") in ("01", "03"):
                    return {"ok": False, "reason": "paper", "pre_status": pre,
                            "recovered_open_doc": recovered}
                # 3. Enviar líneas.
                enviadas = []
                cierre_ack = False  # ¿ya ACKeo el pago total '1XX' (cierra el doc)?
                for line in lines:
                    line = str(line).rstrip('\r\n')
                    if not line.strip():
                        continue
                    ok = self.send_cmd(line, _keep_open=True)
                    enviadas.append({"line": line, "ok": ok})
                    es_cierre = len(line) == 3 and line[0] == '1' and line[1:].isdigit()
                    if not ok:
                        if es_cierre and not cierre_ack:
                            # El ACK del pago total puede perderse (el equipo esta
                            # ocupado imprimiendo/cortando y responde tarde). Antes
                            # de dar el documento por fallido — y que el POS lo
                            # reenvie generando una factura DUPLICADA — constatar
                            # con el status si realmente quedo abierto.
                            for _ in range(6):
                                time.sleep(0.5)
                                post = self._read_status_locked()
                                if not (post and post.get("status") in _IN_TRANSACTION):
                                    return {"ok": True, "reason": "warn_close_ack_lost",
                                            "line": line, "sent": enviadas, "pre_status": pre,
                                            "post_status": post, "recovered_open_doc": recovered}
                        if cierre_ack:
                            # El pago total ya ACKeo: el documento fiscal esta
                            # CERRADO con numero asignado. Reportar error aqui
                            # (tipico: NAK/timeout en el '199' de corte) haria que
                            # el POS lo de por no impreso y reenvie -> factura
                            # DUPLICADA con consecutivo nuevo. Exito con aviso,
                            # sin cancelar (no hay doc parcial que cancelar).
                            post = self._read_status_locked()
                            return {"ok": True, "reason": "warn_tail_failed", "line": line,
                                    "sent": enviadas, "pre_status": pre, "post_status": post,
                                    "recovered_open_doc": recovered}
                        self.send_cmd("7", _keep_open=True)  # cancelar doc parcial
                        post = self._read_status_locked()
                        return {"ok": False, "reason": "nak_line", "line": line,
                                "sent": enviadas, "pre_status": pre, "post_status": post,
                                "recovered_open_doc": recovered}
                    # Pago total = '1' + 2 digitos del medio (ej. '101', '120');
                    # el '199' posterior tambien matchea pero cierre_ack ya es True.
                    if es_cierre:
                        cierre_ack = True
                # 4. Post-flight (diagnóstico). NO se cancela ni se falla por esto:
                #    si todas las líneas dieron ACK, reimprimir sería peor (doble factura).
                #    El equipo tarda en finalizar/cortar, así que SONDEAMOS el estado
                #    varias veces: apenas quede fuera de transacción, está cerrado.
                post = None
                closed = False
                for _ in range(6):
                    time.sleep(0.5)
                    post = self._read_status_locked()
                    if not (post and post.get("status") in _IN_TRANSACTION):
                        closed = True
                        break
                return {"ok": True, "reason": None if closed else "warn_not_closed",
                        "sent": enviadas, "pre_status": pre, "post_status": post,
                        "recovered_open_doc": recovered}
            finally:
                self.close()

    # ---- lectura de data (SubirDataStatus / SubirDataReport) ----
    def _subir_data_status(self, cmd):
        """Una sola trama: STX + payload + ETX + LRC. Devuelve el payload (str)."""
        resp = self._send_frame_and_read(cmd)
        if len(resp) > 3:
            payload = bytes(resp[i] for i in range(len(resp))
                            if i not in (0, len(resp) - 2, len(resp) - 1) and resp[i] != ETX)
            return payload.decode(ENCODING, errors='ignore')
        return ""

    def _subir_data_report(self, cmd):
        """Multi-trama: handshake ENQ->ACK, tramas terminadas en ETB (sigue) / ETX (fin).

        Devuelve lista de payloads (str), en orden.
        """
        frames = []
        resp = self._send_frame_and_read(cmd)
        if len(resp) > 0 and resp[0] == ENQ:
            time.sleep(0.1)
            resp = self._write_and_read(bytes([ACK]))
            while len(resp) > 0 and resp[0] != EOT and resp[0] != NAK:
                payload = bytes(resp[i] for i in range(len(resp))
                                if i not in (0, len(resp) - 2, len(resp) - 1) and resp[i] != ETX)
                frames.append(payload.decode(ENCODING, errors='ignore'))
                # resp[-2] es ETB (viene mas) o ETX (ultima). En ambos casos: ACK.
                resp = self._write_and_read(bytes([ACK]))
        return frames

    def get_status_data(self, cmd):
        """Getter generico de status Sx (S1..S8, SG, SM, SR, SS, ...). Devuelve payload crudo."""
        with _SERIAL_LOCK:
            if not self.open():
                return None
            try:
                data = self._subir_data_status(cmd)
                return data if data else None
            finally:
                self.close()

    def get_s1_data(self):
        """S1: datos de la maquina (RIF, serial, contadores) ya parseados."""
        raw = self.get_status_data("S1")
        return parse_s1(raw) if raw else None

    def get_report_raw(self, cmd):
        """Reporte multi-trama crudo (lista de lineas)."""
        with _SERIAL_LOCK:
            if not self.open():
                return None
            try:
                return self._subir_data_report(cmd)
            finally:
                self.close()

    # ---- reportes X/Z: LEER data (U*) ----
    def get_x_report(self):
        frames = self.get_report_raw("U0X")
        return parse_report_data(frames[-1]) if frames else None

    def get_z_report(self):
        frames = self.get_report_raw("U0Z")
        return parse_report_data(frames[-1]) if frames else None

    def get_z_reports_by_number(self, start, end):
        cmd = f"U3A{int(start):06d}{int(end):06d}"
        frames = self.get_report_raw(cmd)
        return [parse_report_data(f) for f in frames] if frames else None

    def get_z_reports_by_date(self, start_ddmmyy, end_ddmmyy):
        """Fechas en formato DDMMYY (como las envia el comando U2A)."""
        cmd = f"U2A{start_ddmmyy}{end_ddmmyy}"
        frames = self.get_report_raw(cmd)
        return [parse_report_data(f) for f in frames] if frames else None

    # ---- comandos de red / WIFI (WM12..15, WD13) ----
    #  Usan un lector multi-trama distinto (SubirDataReportWIFI). Port fiel del
    #  SDK; SIN validar contra hardware (ver TFHKA_PROTOCOLO.md).
    def _subir_data_report_wifi(self, cmd):
        frames = []
        num5 = 0
        n = 1
        while n == 1 and num5 < self.retry_attempts + 2:
            resp = self._send_frame_and_read(cmd)
            n = len(resp)
            if n > 0 and resp[0] != EOT and resp[0] != NAK:
                time.sleep(0.05)
                resp = self._write_and_read(bytes([ACK]))
                while len(resp) > 0 and resp[0] == STX:
                    ln = len(resp)
                    term_idx = ln - 3  # WIFI: terminador en len-3 (no len-2)
                    payload = bytes(resp[i] for i in range(ln)
                                    if i not in (0, term_idx, ln - 2) and resp[i] != ETX)
                    frames.append(payload.decode(ENCODING, errors='ignore'))
                    resp = self._write_and_read(bytes([ACK]))
            num5 += 1
            time.sleep(0.02)
        return frames

    def get_network_data(self, cmd):
        """Lee un comando de red/WIFI (CW=WM13, IP=WM12, URL=WM14, RED=WM15, CD=WD13)."""
        with _SERIAL_LOCK:
            if not self.open():
                return None
            try:
                frames = self._subir_data_report_wifi(cmd)
                return "\r\n".join(frames) if frames else None
            finally:
                self.close()

    NETWORK_COMMANDS = {"ip": "WM12", "cw": "WM13", "url": "WM14", "red": "WM15", "cd": "WD13"}

    def get_network(self, what):
        """what in {ip, cw, url, red, cd}."""
        cmd = self.NETWORK_COMMANDS.get(what.lower())
        if not cmd:
            return None
        return self.get_network_data(cmd)

    # ---- reportes X/Z: IMPRIMIR (I*) ----
    def print_x_report(self):
        return self.send_cmd("I0X")

    def print_z_report(self):
        return self.send_cmd("I0Z")

    def print_z_reports_by_number(self, start, end):
        return self.send_cmd(f"I3A{int(start):06d}{int(end):06d}")

    def print_z_reports_by_date(self, start_ddmmyy, end_ddmmyy):
        return self.send_cmd(f"I2A{start_ddmmyy}{end_ddmmyy}")

    def cancel_document(self):
        """SendCmd(7): cancela el documento fiscal en curso."""
        return self.send_cmd("7")

    # ---- modo FEL / JSON (SendCmdFel), modelos con facturacion electronica ----
    def send_cmd_fel(self, payload):
        """Envia un comando JSON (FEL) o normal y devuelve la respuesta cruda (str)."""
        with _SERIAL_LOCK:
            if not self.open():
                return '[{"code":"999","message":"No se pudo abrir el puerto"}]'
            try:
                payload = payload.replace('\n', '').replace('\r', '')
                if payload.startswith('{') and payload.endswith('}'):
                    data = payload.encode(ENCODING)  # JSON crudo, sin framing
                else:
                    data = self._build_packet(payload)
                resp = self._write_and_read(data)
                if resp:
                    return resp.decode(ENCODING, errors='ignore')
                return '[{"code":"999","message":"No se recibio respuesta del servidor"}]'
            except Exception as e:
                return '[{"code":"999","message":"' + str(e) + '"}]'
            finally:
                self.close()


# ---------------------------------------------------------------------------
#  Funciones de conveniencia (compat con la API de hka_serial.py)
# ---------------------------------------------------------------------------
def check_printer(port='COM6'):
    p = Tfhka(port=port)
    connected = p.check_fprinter()
    return {"connected": connected, "port": port,
            "error": p.last_error if not connected else None}


def send_fiscal_file(port, filepath):
    p = Tfhka(port=port)
    success, result = p.send_file(filepath)
    return {"success": success, "result": result, "port": port}


def send_command(port, command):
    """Compat: envia un comando y devuelve ACK ok/no."""
    p = Tfhka(port=port)
    ok = p.send_cmd(command)
    return {"success": ok, "response": "ACK" if ok else None, "port": port,
            "error": p.last_error if not ok else None}


if __name__ == '__main__':
    import sys
    port = sys.argv[1] if len(sys.argv) > 1 else 'COM6'
    print(f"=== Test Tfhka en {port} ===")
    p = Tfhka(port=port)
    print("check_fprinter:", p.check_fprinter())
    print("status:", p.get_printer_status())
