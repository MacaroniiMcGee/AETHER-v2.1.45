#!/usr/bin/python3

"""
osdpcontroller.py
Author: Taylor Schmidt

OSDP operation manager.
"""

import logging
import time
import os
from typing import List, Tuple, Optional

from osdplib.osdpdevice import OsdpDevice
from osdplib.secureosdpdevice import SecureOsdpDevice
from osdplib.osdp.command import CommandFactory, SecureCommandFactory
import osdplib.ibeaconconf as ibc
from osdplib import osdp
from osdplib.osdp import ResponseTags, FileTransferStatus, FileFragmentConstants, \
    parse_tamper_data, parse_card_data, CommandTags, SecurityConstants, SCBK_D_KEY
from osdplib.osdp.utils import encrypt
from Crypto.Cipher import AES


def _parse_file(filepath: str) -> Tuple[int, List[bytes]]:
    """
    Parse a file into binary fragments for sending to a reader.
    
    Args:
        filepath (str): The path to the file to be parsed.
    
    Returns:
        Tuple[int, List[bytes]]: A tuple containing the total file size and a list of binary fragments.
    """
    logging.info("parsing %s for transfer...", filepath)
    with open(filepath, "rb") as file:
        contents: bytes = file.read()
        total: int = len(contents)
        frags: List[bytes] = []

        while len(contents) > 0:
            frags.append(contents[:FileFragmentConstants.FILE_FRAGMENT_MAX])
            contents = contents[FileFragmentConstants.FILE_FRAGMENT_MAX:]

        return total, frags


class OsdpController:
    """
    High level coordinator for communicating with a connected OSDP device.
    """

    def __init__(self, port: str, baud_rate: int = 9600, use_crc: bool = False, secure: bool = False, scbk: Optional[bytes] = SCBK_D_KEY):
        """
        Setup and connect an OSDP device at the specified port and baud rate.
        
        Args:
            port (str): The serial port to which the OSDP device is connected.
            baud_rate (int): The baud rate for the serial communication.
            use_crc (bool): Whether to use CRC for message integrity.
            secure (bool): Whether to use a secure OSDP device.
            scbk (Optional[bytes]): The Secure Channel Base Key for the secure channel.
        """
        self.sequence = 0
        self.secure_channel_initialized = False

        if secure:
            self.s_key_dict = {}
            self.scbk = scbk
            self.dev = SecureOsdpDevice(port, baud_rate=baud_rate, scbk=scbk or osdp.SCBK_D_KEY, use_crc=use_crc)
            self.command_factory = SecureCommandFactory(use_crc=use_crc, scbk=self.scbk)
            self.initialize_secure_channel()
        else:
            self.dev = OsdpDevice(port, baud_rate=baud_rate, use_crc=use_crc)
            self.command_factory = CommandFactory(use_crc=use_crc)

    def advance_sequence(self) -> None:
        """
        Advance the sequence counter for OSDP messages.
        """
        self.sequence += 1
        if self.sequence > 3:
            self.sequence = 1

    def send(self, command_tag: CommandTags, data: Optional[bytes] = None, security_type: Optional[SecurityConstants] = None) -> osdp.Response:
        """
        Send a command to the device and get the response.
        
        Args:
            command_tag (CommandTags): The command tag indicating the type of command.
            data (Optional[bytes]): The data to be sent with the command.
            security_type (Optional[SecurityConstants]): The security type for the command.
        
        Returns:
            osdp.Response: The response from the device.
        """
        if self.secure_channel_initialized:
            command = self.command_factory.create_secure_command(command_tag, self.sequence, self.dev.address, data, security_type, self.s_key_dict, self.get_mac())
            response = self.dev.send_command(command, wrap_type=None, s_key_dict=self.s_key_dict)
            self.set_mac(response.computed_mac)
        else:
            command = self.command_factory.create_command(command_tag, self.sequence, self.dev.address, data, security_type)
            response = self.dev.send_command(command)
        self.advance_sequence()
        return response

    def handle_response(self, response: osdp.Response) -> None:
        """
        Handle the response from the device.
        
        Args:
            response (osdp.Response): The response from the device.
        """
        if response is None:
            logging.error("no response")
            return

        tag, data = response.code, response.data

        if tag == ResponseTags.RAW_CARD:
            bits, bitstream = parse_card_data(data)
            logging.info("card: %d, %s", bits, bitstream.hex())
        elif tag == osdp.ResponseTags.LSTATR:
            tamper = parse_tamper_data(data)
            logging.info("tamper %d", tamper)
        elif tag == ResponseTags.ACK:
            logging.debug("ack")
        elif tag == ResponseTags.NAK:
            logging.error("nak")
        elif tag == 0:
            logging.error("malformed response")
        else:
            # simply print the tag of any msgs not handled by this script
            logging.warning("unhandled %d", tag)

    def poll_forever(self) -> None:
        """
        Poll the connected device indefinitely and report various response messages.
        """
        logging.info("osdp controller is polling forever...")

        while True:
            response = self.send(CommandTags.POLL)
            self.handle_response(response)
            time.sleep(0.100)

    def transfer_file(self, filepath: str) -> None:
        """
        Transfer an entire firmware/config binary file to a reader.
        
        Args:
            filepath (str): The path to the file to be transferred.
        """
        logging.info("osdp controller transfer file...")

        # parse the file into fragments and reset offset and delay
        total, frags = _parse_file(filepath)
        offset: int = 0
        delay: float = 0.500
        logging.info("ready to send %d bytes in %d fragments", total, len(frags))

        # send each fragment to the reader
        for fragment in frags:
            response = self.send(CommandTags.FILETRANSFER, osdp.make_filetransfer_command(fragment, offset, total))
            offset += len(fragment)

            if response.code == ResponseTags.FTSTAT:
                status, new_delay = response.ft_status, response.ft_delay

                if status <= FileTransferStatus.FT_FINISHING:
                    delay = float(new_delay) / 1000.0
                else:
                    logging.error("invalid file transfer response received")
                    logging.error("aborting...")
                    break

                time.sleep(delay + 0.05)
            else:
                logging.error("invalid file transfer response received")
                logging.error("aborting...")
                return

        # wait for the reader to finish processing the file by checking
        # ftstat responses
        logging.info("all fragments transferred, waiting to complete...")
        while True:
            response = self.send(CommandTags.FILETRANSFER, osdp.make_filetransfer_command(bytes([]), total, total))

            if response.code == ResponseTags.FTSTAT:
                status, new_delay = response.ft_status, response.ft_delay

                if status in [FileTransferStatus.FT_OK,
                              FileTransferStatus.FT_FINISHING]:
                    delay = float(new_delay) / 1000.0
                elif status == FileTransferStatus.FT_REBOOTING:
                    logging.info("rebooting status received, ending file transfer")
                    break
                elif status == FileTransferStatus.FT_PROCESSED:
                    logging.info("processed status received, ending file transfer")
                    break
                else:
                    logging.error("invalid file transfer response received")
                    logging.error("aborting...")
                    break

                time.sleep(delay + 0.05)
            else:
                logging.error("invalid file transfer response received")
                logging.error("aborting...")
                break

        logging.info("file transfer end")

    def send_ibeacon_mfg(self) -> bool:
        """
        Sends the statically defined ibeacon/touch configuration block defined
        in the `ibeaconconf` module.
        
        Returns:
            bool: True if the command was acknowledged, False otherwise.
        """
        response = self.send(CommandTags.MFG, bytes([0x92, 0x00]))
        _, conf = response.code, response.data

        # example conf block
        # 5c2623579218000000000000000059060400040001000001000000060000
        serial = conf[6:14]
        name = ibc.gen_name_from_serial(serial)

        response = self.send(CommandTags.MFG, ibc.make_config_block(name))
        return response.code == osdp.ResponseTags.ACK

    def request_conf(self) -> str:
        """
        Gets the extended config block of the reader.
        
        Returns:
            str: The configuration block in hexadecimal format.
        """
        response = self.send(CommandTags.MFG, bytes([0x92, 0x00]))
        return response.data.hex()

    def initialize_secure_channel(self):
        logging.debug("Initializing secure channel")

        self.random_a = os.urandom(8)  # Generate 8-byte random number for secure channel
        # self.random_a = b'\xb0\xb1\xb2\xb3\xb4\xb5\xb6\xb7' # Example random_a
        self.compute_session_keys(self.random_a)  # Compute session keys immediately after generating random_a

        response = self.send(CommandTags.CHLNG, data=self.random_a, security_type=SecurityConstants.SCS_11)
        client_id, random_b, _ = self.process_scs_12_response(response)
        
        response = self.send(CommandTags.SCRYPT, security_type=SecurityConstants.SCBK, data=self.calc_cryptogram(self.s_key_dict['s_enc'], random_b, self.random_a))
        self.process_scs_14_response(response)

        logging.info("Secure channel initialized")
        self.secure_channel_initialized = True
        self.dev.secure_channel_initialized = True

        self.test_secure_channel()
        self.send(CommandTags.POLL, security_type=SecurityConstants.SCS_17)

    def process_scs_12_response(self, response):
        if response is None:
            raise RuntimeError("Failed to initialize secure channel. No response to SCS_11.")
        if response.code == ResponseTags.NAK:
            raise RuntimeError("Failed to initialize secure channel. Got osdp_NAK in response to SCS_11.")
        if response.code != ResponseTags.CCRYPT:
            raise RuntimeError(f"Invalid response from secure channel initialization. Got: {response}, expected: osdp_CCRYPT")

        client_id = response.client_id
        random_b = response.random_number_b
        client_cryptogram = response.cryptogram

        calculated_client_cryptogram = self.calc_cryptogram(self.s_key_dict['s_enc'], self.random_a, random_b)
        if calculated_client_cryptogram != client_cryptogram:
            logging.error(f"Client cryptogram mismatch. Calculated: {calculated_client_cryptogram.hex()}, Received: {client_cryptogram.hex()}")
            raise RuntimeError(f"Client cryptogram mismatch. Calculated: {calculated_client_cryptogram.hex()}, Received: {client_cryptogram.hex()}")

        return client_id, random_b, client_cryptogram

    def process_scs_14_response(self, response):
        if response is None:
            raise RuntimeError("Failed to initialize secure channel. No response to SCS_13.")
        if response.code is not ResponseTags.RMAC_I:
            raise RuntimeError(f"Invalid response from secure channel initialization. Got: {response}, expected: osdp_RMAC_I")

        self.set_mac(response.rmac_i)

    def test_secure_channel(self):
        logging.debug("Testing secure channel")
        response = self.send(CommandTags.POLL, data=b'', security_type=SecurityConstants.SCS_15)
        if response is None:
            logging.debug("No response to SCS_15. This is fine for production mode devices.")
        elif response.code == ResponseTags.NAK:
            logging.debug("Received osdp_NAK in response to SCS_15. This is fine for production mode devices.")

    def compute_session_keys(self, rnd_a):
        def derive_key(scbk, rnd_a, key_type):
            data = bytes([0x01, key_type]) + rnd_a[:6] + bytes(8)
            key = encrypt(scbk, data, mode=AES.MODE_ECB)
            return key

        self.s_enc = derive_key(self.scbk, rnd_a, SecurityConstants.S_ENC_KEY_TYPE)
        self.s_mac1 = derive_key(self.scbk, rnd_a, SecurityConstants.S_MAC1_KEY_TYPE)
        self.s_mac2 = derive_key(self.scbk, rnd_a, SecurityConstants.S_MAC2_KEY_TYPE)
        logging.debug(f"Session keys: s_enc: {self.s_enc.hex()}, s_mac1: {self.s_mac1.hex()}, s_mac2: {self.s_mac2.hex()}")

        self.s_key_dict = {
            's_enc': self.s_enc,
            's_mac1': self.s_mac1,
            's_mac2': self.s_mac2,
        }
        return self.s_enc, self.s_mac1, self.s_mac2

    def calc_cryptogram(self, s_enc, rnd_a, rnd_b):
        """Calculate cryptogram."""
        concatenated_rnds = rnd_a + rnd_b
        assert len(concatenated_rnds) == 16, "Concatenated RND.A and RND.B must be 16 bytes long"
        cryptogram = encrypt(s_enc, concatenated_rnds, mode=AES.MODE_ECB)
        logging.debug("Calculated Cryptogram: %s", cryptogram.hex())
        return cryptogram

    def set_mac(self, mac):
        self.s_key_dict['mac_i'] = mac

    def get_mac(self):
        return self.s_key_dict.get('mac_i')
