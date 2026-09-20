import logging
from typing import Tuple, Optional
from osdplib import osdp
from osdplib.osdp import Command, Response, MessagingConstants, SecurityConstants, ResponseTags
from osdplib.osdp.utils import encrypt, calc_mac
from osdplib.osdp.command import SecureCommandFactory
from osdplib.osdp.constants import SCBK_D_KEY, CommandTags
from Crypto.Cipher import AES
from osdplib.osdpdevice import OsdpDevice

class SecureOsdpDevice(OsdpDevice):
    def __init__(self, port: str, baud_rate: int = 9600, address: int = MessagingConstants.DEFAULT_ADDR, scbk=SCBK_D_KEY, use_crc: bool = False):
        super().__init__(port, baud_rate, address, use_crc)
        self.scbk = scbk
        self.s_key_dict = {}
        self.use_crc = use_crc
        self.secure_channel_initialized = False
        self.scbk_type = SecurityConstants.SCBK_D if self.scbk == SCBK_D_KEY else SecurityConstants.SCBK
        self.command_factory = SecureCommandFactory(use_crc=use_crc)

    def send_command(self, command: Command, wrap_type: Optional[SecurityConstants] = None, s_key_dict: dict = None) -> Response:
        """
        Sends a command and returns the response. Wraps the command in SCS_17 or SCS_15 if specified.

        Args:
            command (Command): The original command to be sent.
            wrap_type (Optional[str]): Either 'SCS_15' or 'SCS_17'. Default is None.

        Returns:
            Response: The response from the device.
        """
        if self.secure_channel_initialized and wrap_type is None:
            wrap_type = SecurityConstants.SCS_17

        if wrap_type is not None and not command._wrapped:
            command = self.wrap_command(command, wrap_type, s_key_dict)

        return self._send_command(command)

    def wrap_command(self, command: Command, wrap_type: SecurityConstants, s_key_dict: dict = None) -> Command:
        logging.info(f"Wrapping command: {command}")
        if command._wrapped:
            raise ValueError("Command is already wrapped")
    
        if wrap_type not in [None, SecurityConstants.SCS_15, SecurityConstants.SCS_17]:
            raise ValueError("wrap_type must be either None, 'SCS_15', or 'SCS_17'")
        
        if s_key_dict is None:
            raise ValueError("s_key_dict must be provided")

        if wrap_type is None:
            return command

        security_block = {'type': wrap_type.value, 'block': b'\x02' + bytes([wrap_type.value])}

        self.s_key_dict = s_key_dict
        
        wrapped_command = Command(
            command=command.command,
            data=command.data,
            sequence=command.sequence,
            address=command.address,
            security_block=security_block,
            last_mac=self.get_mac(),
            encryption_dict=self.s_key_dict,
            encrypt_data=(wrap_type == SecurityConstants.SCS_17),
            use_crc=self.use_crc  # Pass the use_crc parameter
        )

        # Set the MAC to the command's MAC
        self.set_mac(wrapped_command.last_mac)

        wrapped_command._wrapped = True
        return wrapped_command

    def _send_command(self, command: Command) -> Response:
        logging.debug(f"Command: {command}")
        try:
            cmd: bytes = command.message
            rsp: bytes = self.write_cmd_rsp(cmd)

            response = osdp.parse_response(rsp, self.s_key_dict)
            logging.debug(f"Response: {response}")

            if response.has_mac:
                self.set_mac(response.computed_mac)
            return response
        
        except Exception as e:
            logging.error(f"Failed to send command or receive response: {e}")
            raise

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
