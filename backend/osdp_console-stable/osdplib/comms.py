#!/usr/bin/python3
"""
comms.py
Author: Taylor Schmidt

Communication helper functions for connecting serial devices.
"""

import logging
import os
import sys
from typing import List, Optional

import serial

PLATFORM_WIN = "win"
PLATFORM_MACOS = "darwin"

PORT_MATCH = "tty.usb"


def find_ports() -> List[str]:
    """
    Find all available ports based on a match.
    """
    if sys.platform.startswith(PLATFORM_WIN):
        # Windows COM ports
        return [port.device for port in serial.tools.list_ports.comports()]

    if sys.platform.startswith(PLATFORM_MACOS):
        all_ports: List[str] = os.listdir("/dev/")
        return list(filter(lambda p: PORT_MATCH in p, all_ports))

    raise Exception("Cannot find Linux ports, please specify a port using --port argument.")


def prompt_port() -> Optional[str]:
    """
    Display a list of numbered ports via cli and allow the user to choose.
    """
    ports: List[str] = find_ports()

    for index, port in enumerate(ports):
        print("[" + str(index) + "]" + " " + port)

    try:
        selected: int = int(input("\n---- Select port number: "))
        return ports[selected]
    except Exception as err:
        print(f"invalid port: #{selected} selected")
        print(err)
        return None


class Device:
    """
    Serial device abstraction with optimized full-frame receive logic.
    """

    def __init__(self, port: str, baud_rate: int = 9600):
        self.port: str = port
        self.baud_rate: int = baud_rate
        self.connect()

    def connect(self):
        """
        Connect to a serial device.
        """
        logging.info("Connecting to device at: %s with baud rate: %d", self.port, self.baud_rate)
        # reply time should take no longer than 200ms
        # prepend "/dev/" on Unix platforms; Windows uses full COM names
        device_path = self.port
        if not sys.platform.startswith(PLATFORM_WIN):
            device_path = "/dev/" + self.port
        self.ser: serial.Serial = serial.Serial(device_path, self.baud_rate, timeout=0.200)

    def write_cmd_rsp(self, cmd: bytes) -> bytes:
        """
        Send a command (with FF prefix) and block until a full OSDP frame comes back.
        """
        # prepend frame start marker
        full_cmd = b"\xFF" + cmd
        logging.debug("> %s", full_cmd.hex())
        # clear any spurious data
        try:
            self.ser.reset_input_buffer()
        except Exception:
            pass
        self.ser.write(full_cmd)
        # read full frame
        rsp = self._receive_full_frame()
        logging.debug("< %s", rsp.hex())
        return rsp

    def send(self, cmd: bytes) -> None:
        """
        Send a raw command to the serial device.
        """
        logging.debug("> %s", cmd.hex())
        self.ser.write(cmd)

    def receive(self) -> bytes:
        """
        Receive a complete OSDP frame from the device, streaming byte by byte.
        """
        rsp = self._receive_full_frame()
        logging.debug("< %s", rsp.hex())
        return rsp

    def clean_response(self, rsp: bytes) -> bytes:
        """
        Remove one or more leading 0xFF bytes from the response message.
        """
        for idx, byte in enumerate(rsp):
            if byte != 0xFF:
                return rsp[idx:]
        return b""

    def _receive_full_frame(self) -> bytes:
        """
        Blocking read for a full OSDP frame:
        1) wait byte-by-byte for SOM (0x53),
        2) read ADDR + LEN_LSB + LEN_MSB,
        3) compute the remaining length and read in chunks.
        """
        buf = bytearray()

        # 1) find SOM
        while True:
            b = self.ser.read(1)
            if not b:
                raise TimeoutError("Timeout waiting for SOM")
            if b[0] == 0x53:
                buf.append(0x53)
                break

        # 2) read 3-byte header
        hdr = self.ser.read(3)
        if len(hdr) < 3:
            raise TimeoutError(f"Timeout reading header, got {len(hdr)} bytes")
        buf.extend(hdr)
        _, lsb, msb = hdr

        # 3) compute total length
        total_len = lsb | (msb << 8)
        if total_len < 4:
            raise ValueError(f"Invalid length: {total_len}")
        to_read = total_len - 4

        # 4) read remaining payload
        while to_read:
            chunk = self.ser.read(to_read)
            if not chunk:
                raise TimeoutError(f"Timeout waiting for {to_read} more bytes")
            buf.extend(chunk)
            to_read -= len(chunk)

        return bytes(buf)
