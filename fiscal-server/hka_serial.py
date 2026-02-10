"""
Comunicación serial directa con impresoras fiscales HKA
Reemplaza IntTFHKA.exe que tiene problemas de compatibilidad
"""

import serial
import time
import os

# Caracteres de control del protocolo HKA
STX = 0x02  # Start of Text
ETX = 0x03  # End of Text
ENQ = 0x05  # Enquiry
ACK = 0x06  # Acknowledge
NAK = 0x15  # Negative Acknowledge
EOT = 0x04  # End of Transmission

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
        """Cierra conexión"""
        if self.serial and self.serial.is_open:
            self.serial.close()
            
    def is_connected(self):
        """Verifica si la impresora está conectada"""
        try:
            if not self.open():
                return False
            
            # Enviar ENQ y esperar respuesta
            self.serial.write(bytes([ENQ]))
            time.sleep(0.3)
            
            if self.serial.in_waiting > 0:
                response = self.serial.read(self.serial.in_waiting)
                self.close()
                # Si recibe algo, la impresora está conectada
                return len(response) > 0
            
            self.close()
            return False
        except Exception as e:
            self.last_error = str(e)
            self.close()
            return False
    
    def calculate_lrc(self, data):
        """Calcula LRC (Longitudinal Redundancy Check)"""
        lrc = 0
        for byte in data:
            lrc ^= byte
        return lrc
    
    def send_command(self, command):
        """Envía un comando a la impresora"""
        try:
            if not self.open():
                return None
            
            # Formato: STX + comando + ETX + LRC
            cmd_bytes = command.encode('latin-1')
            packet = bytes([STX]) + cmd_bytes + bytes([ETX])
            lrc = self.calculate_lrc(cmd_bytes + bytes([ETX]))
            packet += bytes([lrc])
            
            # Limpiar buffer
            self.serial.reset_input_buffer()
            
            # Enviar comando
            self.serial.write(packet)
            time.sleep(0.5)
            
            # Leer respuesta
            response = b''
            start_time = time.time()
            while time.time() - start_time < self.timeout:
                if self.serial.in_waiting > 0:
                    response += self.serial.read(self.serial.in_waiting)
                    time.sleep(0.1)
                else:
                    if response:
                        break
                    time.sleep(0.1)
            
            self.close()
            return response.decode('latin-1', errors='ignore')
        except Exception as e:
            self.last_error = str(e)
            self.close()
            return None
    
    def send_file(self, filepath):
        """Envía un archivo de factura a la impresora"""
        try:
            if not os.path.exists(filepath):
                self.last_error = f"Archivo no encontrado: {filepath}"
                return False, self.last_error
            
            with open(filepath, 'r', encoding='latin-1') as f:
                lines = f.readlines()
            
            if not self.open():
                return False, self.last_error
            
            # CRÍTICO: Limpiar buffers de entrada y salida para evitar comandos residuales
            self.serial.reset_input_buffer()
            self.serial.reset_output_buffer()
            time.sleep(0.3)
            
            responses = []
            for line in lines:
                # rstrip() solo elimina espacios finales, preserva espacio inicial (código de tasa IVA)
                line = line.rstrip('\r\n')
                if not line.strip():  # Ignorar líneas completamente vacías
                    continue
                
                # Formato: STX + línea + ETX + LRC
                cmd_bytes = line.encode('latin-1')
                packet = bytes([STX]) + cmd_bytes + bytes([ETX])
                lrc = self.calculate_lrc(cmd_bytes + bytes([ETX]))
                packet += bytes([lrc])
                
                self.serial.reset_input_buffer()
                self.serial.write(packet)
                time.sleep(0.5)
                
                # Esperar ACK o respuesta
                response = b''
                start_time = time.time()
                while time.time() - start_time < 3:
                    if self.serial.in_waiting > 0:
                        response += self.serial.read(self.serial.in_waiting)
                        time.sleep(0.1)
                        if self.serial.in_waiting == 0:
                            break
                    time.sleep(0.05)
                
                responses.append({
                    'line': line,
                    'response': response.decode('latin-1', errors='ignore')
                })
                
                # Si recibe NAK, hay error
                if NAK in response:
                    self.close()
                    return False, f"Error en línea: {line}"
            
            self.close()
            return True, responses
        except Exception as e:
            self.last_error = str(e)
            self.close()
            return False, self.last_error
    
    def print_x_report(self):
        """Imprime reporte X"""
        return self.send_command("I0X")
    
    def print_z_report(self):
        """Imprime reporte Z"""
        return self.send_command("I0Z")
    
    def get_status(self):
        """Obtiene estado de la impresora"""
        return self.send_command("S1")
    
    def cancel_document(self):
        """Cancela cualquier documento fiscal pendiente"""
        return self.send_command("7")


def check_printer(port='COM6'):
    """Función para verificar conexión (reemplaza CheckFprinter de IntTFHKA)"""
    printer = HKAPrinter(port=port)
    connected = printer.is_connected()
    return {
        'connected': connected,
        'port': port,
        'error': printer.last_error if not connected else None
    }


def send_fiscal_file(port, filepath):
    """Función para enviar archivo fiscal (reemplaza SendFileCmd de IntTFHKA)"""
    printer = HKAPrinter(port=port)
    success, result = printer.send_file(filepath)
    return {
        'success': success,
        'result': result,
        'port': port
    }


def send_command(port, command):
    """Función para enviar comando (reemplaza SendCmd de IntTFHKA)"""
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
