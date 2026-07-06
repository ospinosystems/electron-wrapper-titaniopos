"""
Comunicación serial directa con impresoras fiscales HKA.

NOTA: El framing actual (STX + CMD + ETX + LRC) NO incluye byte de secuencia.
El protocolo HKA/TFHKA estándar usa STX + SEQ + CMD + ETX + LRC. Si en algún
cliente la impresora deja de responder o devuelve NAK consistentemente,
setear USE_HKA_SERIAL=0 para volver a IntTFHKA.exe mientras se valida el
framing correcto contra hardware real.
"""

import serial
import time
import os
import threading

# Caracteres de control del protocolo HKA
STX = 0x02  # Start of Text
ETX = 0x03  # End of Text
ENQ = 0x05  # Enquiry
ACK = 0x06  # Acknowledge
NAK = 0x15  # Negative Acknowledge
EOT = 0x04  # End of Transmission

# Lock global: Flask es multi-threaded y el puerto serial no se puede compartir
# entre threads. Sin esto, dos requests simultáneos corrompen el stream.
_SERIAL_LOCK = threading.RLock()

# Reintentos en NAK antes de fallar
MAX_RETRIES = 3


class HKAPrinter:
    def __init__(self, port='COM6', baudrate=9600, timeout=5):
        self.port = port
        self.baudrate = baudrate
        self.timeout = timeout
        self.serial = None
        self.last_error = ""

    def open(self):
        """Abre conexión con la impresora"""
        try:
            if self.serial and self.serial.is_open:
                return True
            self.serial = serial.Serial(
                port=self.port,
                baudrate=self.baudrate,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=self.timeout,
                write_timeout=self.timeout
            )
            return True
        except Exception as e:
            self.last_error = str(e)
            return False

    def close(self):
        """Cierra conexión (silencioso ante cualquier error)"""
        try:
            if self.serial and self.serial.is_open:
                self.serial.close()
        except Exception:
            pass

    def is_connected(self):
        """Verifica si la impresora está conectada enviando ENQ"""
        with _SERIAL_LOCK:
            try:
                if not self.open():
                    return False
                self.serial.reset_input_buffer()
                self.serial.write(bytes([ENQ]))
                # Espera más generosa: algunas térmicas tardan 500-800ms
                deadline = time.time() + 1.5
                response = b''
                while time.time() < deadline:
                    if self.serial.in_waiting > 0:
                        response += self.serial.read(self.serial.in_waiting)
                        time.sleep(0.05)
                        if self.serial.in_waiting == 0 and response:
                            break
                    else:
                        time.sleep(0.05)
                return len(response) > 0
            except Exception as e:
                self.last_error = str(e)
                return False
            finally:
                self.close()

    def calculate_lrc(self, data):
        """Calcula LRC (XOR longitudinal)"""
        lrc = 0
        for byte in data:
            lrc ^= byte
        return lrc

    def _build_packet(self, command):
        """Construye trama STX + CMD + ETX + LRC.

        NOTA: Este modelo de impresora HKA NO usa byte de secuencia (SEQ).
        Validado con hardware real: el framing sin SEQ funciona para
        comentarios, productos y pagos (con monto).
        """
        cmd_bytes = command.encode('latin-1') if isinstance(command, str) else command
        body = cmd_bytes + bytes([ETX])
        lrc = self.calculate_lrc(body)
        return bytes([STX]) + body + bytes([lrc])

    def _read_response(self, max_wait=None):
        """Lee la respuesta hasta que no llegue más data por 100ms o timeout."""
        if max_wait is None:
            max_wait = self.timeout
        response = b''
        deadline = time.time() + max_wait
        last_data_time = time.time()
        while time.time() < deadline:
            if self.serial.in_waiting > 0:
                response += self.serial.read(self.serial.in_waiting)
                last_data_time = time.time()
                time.sleep(0.05)
            else:
                # Si ya recibimos algo y pasaron 150ms sin nada nuevo, terminamos
                if response and (time.time() - last_data_time) > 0.15:
                    break
                time.sleep(0.05)
        return response

    def send_command(self, command):
        """Envía un comando a la impresora con reintentos en NAK"""
        with _SERIAL_LOCK:
            try:
                if not self.open():
                    return None

                packet = self._build_packet(command)

                for attempt in range(1, MAX_RETRIES + 1):
                    # Limpiar buffer ANTES del write para no perder respuestas
                    self.serial.reset_input_buffer()
                    self.serial.write(packet)
                    self.serial.flush()

                    response = self._read_response()

                    if NAK in response and attempt < MAX_RETRIES:
                        self.last_error = f"NAK recibido (intento {attempt})"
                        time.sleep(0.3)
                        continue

                    return response.decode('latin-1', errors='ignore')

                return None
            except Exception as e:
                self.last_error = str(e)
                return None
            finally:
                self.close()

    def send_file(self, filepath):
        """Envía un archivo de factura a la impresora línea por línea"""
        with _SERIAL_LOCK:
            try:
                if not os.path.exists(filepath):
                    self.last_error = f"Archivo no encontrado: {filepath}"
                    return False, self.last_error

                with open(filepath, 'r', encoding='latin-1') as f:
                    lines = f.readlines()

                if not self.open():
                    return False, self.last_error

                self.serial.reset_input_buffer()
                self.serial.reset_output_buffer()
                time.sleep(0.2)

                responses = []
                for idx, line in enumerate(lines):
                    # rstrip() de CR/LF, preserva espacio inicial (código de tasa IVA)
                    line = line.rstrip('\r\n')
                    if not line.strip():
                        continue

                    packet = self._build_packet(line)
                    print(f"[HKA] Sending line {idx}: {line!r} (packet {len(packet)} bytes: {packet.hex()})")

                    sent_ok = False
                    last_resp = b''
                    for attempt in range(1, MAX_RETRIES + 1):
                        # NO reset_input_buffer aquí: podría descartar ACK retrasados.
                        # Drenamos solo si quedó basura previa al write.
                        if self.serial.in_waiting > 0:
                            drained = self.serial.read(self.serial.in_waiting)
                            print(f"[HKA]   Drained {len(drained)} bytes: {drained.hex()}")

                        self.serial.write(packet)
                        self.serial.flush()

                        last_resp = self._read_response(max_wait=3)
                        print(f"[HKA]   Response (attempt {attempt}): {last_resp.hex()} | ACK={'yes' if ACK in last_resp else 'no'} NAK={'yes' if NAK in last_resp else 'no'}")

                        if NAK in last_resp:
                            if attempt < MAX_RETRIES:
                                time.sleep(0.3)
                                continue
                            return False, f"NAK persistente en línea: {line!r}"

                        # Si recibió ACK o cualquier dato sin NAK, OK
                        sent_ok = True
                        break

                    responses.append({
                        'line': line,
                        'response': last_resp.decode('latin-1', errors='ignore'),
                        'attempts': attempt,
                    })

                    if not sent_ok:
                        return False, f"Sin confirmación en línea: {line!r}"

                return True, responses
            except Exception as e:
                self.last_error = str(e)
                return False, self.last_error
            finally:
                self.close()

    def print_x_report(self):
        return self.send_command("I0X")

    def print_z_report(self):
        return self.send_command("I0Z")

    def get_status(self):
        return self.send_command("S1")

    def cancel_document(self):
        return self.send_command("7")


def check_printer(port='COM6'):
    """Verifica conexión (reemplaza CheckFprinter de IntTFHKA)"""
    printer = HKAPrinter(port=port)
    connected = printer.is_connected()
    return {
        'connected': connected,
        'port': port,
        'error': printer.last_error if not connected else None
    }


def send_fiscal_file(port, filepath):
    """Envía archivo fiscal (reemplaza SendFileCmd de IntTFHKA)"""
    printer = HKAPrinter(port=port)
    success, result = printer.send_file(filepath)
    return {
        'success': success,
        'result': result,
        'port': port
    }


def send_command(port, command):
    """Envía comando (reemplaza SendCmd de IntTFHKA)"""
    printer = HKAPrinter(port=port)
    response = printer.send_command(command)
    return {
        'success': response is not None,
        'response': response,
        'port': port,
        'error': printer.last_error if response is None else None
    }


# Test directo
if __name__ == '__main__':
    import sys
    port = sys.argv[1] if len(sys.argv) > 1 else 'COM6'

    print(f"=== Test HKA Serial en {port} ===")
    result = check_printer(port)
    print(f"Conectada: {result['connected']}")
    if result['error']:
        print(f"Error: {result['error']}")
