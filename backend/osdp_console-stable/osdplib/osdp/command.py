# command.py

import logging
from typing import Optional, Callable, Dict
from enum import Enum
from osdplib import byteutil as butil
from .constants import MessagingConstants, CommandTags, SecurityConstants, MFG_OID, MFG_WL_ID, ControlBlockMasks, SCBK_D_KEY, FileFragmentConstants, LEDCodes, LEDTempControlCodes, LEDPermControlCodes
from .utils import calc_checksum, calc_crc, encrypt, calc_mac, ones_complement
from Crypto.Cipher import AES

class Command:
    def __init__(self, command: CommandTags, data: Optional[bytes] = None, sequence: int = MessagingConstants.SQN,
                 address: int = MessagingConstants.DEFAULT_ADDR, security_block: Optional[dict] = None, last_mac=None,
                 encryption_dict: Optional[dict] = None, encrypt_data: Optional[bool] = False, use_crc: bool = False):
        self.command = command
        self.data = data if data is not None else bytes([])
        self.sequence = sequence
        self.address = address
        self.security_block = security_block if security_block is not None else {}
        self.mac_i = last_mac
        self._encryption_dict = encryption_dict if encryption_dict is not None else {}
        self._encrypt_data = encrypt_data
        self._wrapped = False
        self._use_crc = use_crc
        self.message = bytearray()
        self._make_command()

    def _make_command(self) -> bytes:
        self.message = bytearray()
        self.message.append(MessagingConstants.SOM)  # SOM
        self.message.append(self.address)  # Address
        self._append_message_byte_len()  # Length

        use_security_block = self.security_block is not None and self.security_block != {}
        self.cntrl_block = _make_control_block(
            self.sequence, self._use_crc, use_security_block
        )  # Control
        self.message.append(self.cntrl_block)

        if use_security_block:
            # if security_block is a dictionary, just get the "block"
            if isinstance(self.security_block, dict):
                self.security_block = self.security_block.get('block')
            self.message += self.security_block  # Security Block (Optional)

        self.message.append(self.command.value)  # Command Code

        if self._encrypt_data and self.data != bytes([]):
            self.data = self._wrap_data()

        if self.data != bytes([]):
            self.message += self.data  # Data (Optional)

        if self.mac_i is not None and self._encryption_dict.get('s_mac1') is not None and self._encryption_dict.get('s_mac2') is not None:
            self.mac = self._calculate_mac(self.message, self.mac_i)
            self.message += self.mac  # MAC (Optional)

        if not self._use_crc:
            self.chksum = calc_checksum(self.message)
            self.message.append(self.chksum)  # Checksum (Either or CRC)
        else:
            self.crc = calc_crc(self.message)  # CRC
            # self.message += bytes([self.crc & 0xFF, (self.crc & 0xFF00) >> 8])
            self.message += bytes([(self.crc & 0xFF00) >> 8, self.crc & 0xFF])

        return bytes(self.message)

    def _calculate_mac(self, message, mac_i):
        padded_message = message + b'\x80'
        while len(padded_message) % 16 != 0:
            padded_message += b'\x00'
        mac_length = 4  # we'll only send the first 4 bytes of the MAC

        logging.debug("MAC_i for MAC calculation: %s", mac_i.hex())
        logging.debug("Padded message for MAC calculation: %s", padded_message.hex())
        logging.debug("s_mac1: %s", self._encryption_dict.get('s_mac1').hex())
        logging.debug("s_mac2: %s", self._encryption_dict.get('s_mac2').hex())
        logging.debug("s_enc : %s", self._encryption_dict.get('s_enc').hex())
        logging.debug("MAC_i: %s", mac_i.hex())
        mac = mac_i  # Initialize with the previously sent MAC
        for i in range(0, len(padded_message), 16):
            block = padded_message[i:i + 16]
            if i == len(padded_message) - 16:
                mac = encrypt(self._encryption_dict.get('s_mac2'), block, mode=AES.MODE_CBC, iv=mac)
            else:
                mac = encrypt(self._encryption_dict.get('s_mac1'), block, mode=AES.MODE_CBC, iv=mac)
        self.last_mac = mac  # this will be used as the next ICV
        logging.debug("MAC: %s", mac.hex())
        return mac[:mac_length]

    def _wrap_data(self):
        data = bytearray(self.data)

        # # add the encrypted data header
        # header = bytearray([0x0, 0x0, len(data), 0x0])
        # data = header + data

        # pad the data
        pad_character = 0x80
        for i in range(16 - (len(data) % 16)):
            data.append(pad_character)
            pad_character = 0x00

        # icv is the ones complement of mac_i
        icv = ones_complement(self.mac_i)

        encrypted_data = encrypt(self._encryption_dict.get('s_enc'), data, mode=AES.MODE_CBC, iv=icv)
        self.data = encrypted_data
        self.length += i
        self._change_message_byte_len()
        return encrypted_data

    def _append_message_byte_len(self):
        self.length = len(self.data) + len(self.security_block) + MessagingConstants.OVERHEAD
        if self._use_crc:
            self.length += 1
        if self.mac_i is not None and self._encryption_dict.get('s_mac1') is not None and self._encryption_dict.get('s_mac2') is not None:
            self.length += 4
        self.message.append(self.length & 0xFF)
        self.message.append((self.length & 0xFF00) >> 8)

    def _change_message_byte_len(self):
        message_copy = self.message.copy()
        self.message = bytearray()
        self.message.append(MessagingConstants.SOM)  # SOM
        self.message.append(self.address)  # Address
        self._append_message_byte_len()  # Length
        control_byte_index = 4
        self.message += message_copy[control_byte_index:]  # The rest of the message copy

    def __repr__(self) -> str:
        excluded_keys = {'message', '_encryption_dict', 'mac_i', 'last_mac', '_wrapped'}
        ordered_keys = ['command', 'address', 'length', 'cntrl_block', 'sequence', 'data', 'mac', 'chksum', 'crc']

        attrs = {key: value for key, value in vars(self).items() if not key.startswith('_') and value is not None and (key != 'data' or value)}

        ordered_attrs_repr = [
            f'  - {key.upper()}: {attrs[key].name} ({hex(attrs[key].value)})' if isinstance(attrs[key], Enum)
            else f'  - {key.upper()}: {hex(attrs[key])}' if isinstance(attrs[key], int)
            else f'  - {key.upper()}: {attrs[key].hex()}' if isinstance(attrs[key], (bytes, bytearray))
            else f'  - {key.upper()}: {attrs[key]}'
            for key in ordered_keys if key in attrs and key not in excluded_keys and key != 'security_block'
        ]

        if 'security_block' in attrs and attrs['security_block']:
            if isinstance(attrs['security_block'], dict):
                security_block_length = attrs['security_block'].get('length', 0)
                security_block_type = attrs['security_block'].get('type', 0)
                security_block_data = attrs['security_block'].get('data', b'')
                security_block_repr = [
                    f'  - SECURITY_BLOCK_LENGTH: {hex(security_block_length)}',
                    f'  - SECURITY_BLOCK_TYPE: {hex(security_block_type)}',
                    f'  - SECURITY_BLOCK_DATA: {security_block_data.hex()}' if security_block_data else ''
                ]
            elif isinstance(attrs['security_block'], (bytes, bytearray)):
                security_block_repr = [
                    f'  - SECURITY_BLOCK: {attrs["security_block"].hex()}'
                ]
            else:
                security_block_repr = []

            ordered_attrs_repr.extend([line for line in security_block_repr if line])  # Remove empty lines

        remaining_attrs_repr = [
            f'  - {key.upper()}: {value.name} ({hex(value.value)})' if isinstance(value, Enum)
            else f'  - {key.upper()}: {hex(value)}' if isinstance(value, int)
            else f'  - {key.upper()}: {value.hex()}' if isinstance(value, (bytes, bytearray))
            else f'  - {key.upper()}: {value}'
            for key, value in attrs.items() if key not in ordered_keys and key not in excluded_keys and key != 'security_block'
        ]

        attrs_repr = '\n'.join(ordered_attrs_repr + remaining_attrs_repr)
        return f"Command:\n{attrs_repr}\n"


    def get_message(self) -> bytes:
        return self.message

    def hex(self) -> str:
        return self.message.hex()

def make_command(command: CommandTags, data: bytes, sequence: int,
                 address: int = MessagingConstants.DEFAULT_ADDR, security_block=None, use_crc: bool = False) -> Command:
    """
    Creates OSDP command with correct header, length, checksum, etc.
    """
    return Command(command, data, sequence, address, security_block, use_crc=use_crc)

def make_poll_command(sequence: int, address: int = MessagingConstants.DEFAULT_ADDR, use_crc: bool = False) -> Command:
    """
    Creates an OSDP poll command.
    """
    return Command(CommandTags.POLL, sequence=sequence, address=address, use_crc=use_crc)

def make_id_command(sequence: int, address: int = MessagingConstants.DEFAULT_ADDR, use_crc: bool = False) -> Command:
    """
    Creates an OSDP ID command.
    """
    return Command(CommandTags.ID, sequence=sequence, address=address, use_crc=use_crc)

def make_cap_command(sequence: int, address: int = MessagingConstants.DEFAULT_ADDR, use_crc: bool = False) -> Command:
    """
    Creates an OSDP capability command.
    """
    return Command(CommandTags.CAP, sequence=sequence, address=address, use_crc=use_crc)

def make_perm_led_command(cntl: int, ontime: int, offtime: int, oncolor: int, offcolor: int) -> bytes:
    """
    Helper function to change the reader LED color permanently.
    """
    data = [
        0,  # reader num
        0,  # LED num
        LEDTempControlCodes.LED_TEMP_CANCEL.value,  # temp settings (ignored)
        0,
        0,
        0,
        0,
        0,
        0,
        cntl,  # perm settings
        ontime,
        offtime,
        oncolor,
        offcolor,
    ]
    return bytes(data)

def make_mfg_command(data: bytes, oid: bytes = MFG_OID, wl_id: bytes = MFG_WL_ID) -> bytes:
    """
    Helper function to create a WaveLynx reader OSDP manufacturer command.
    """
    return oid + wl_id + data

def make_filetransfer_command(chunk: bytes, offset: int, total: int) -> bytes:
    """
    Creates an OSDP file transfer command.
    """
    data: bytearray = bytearray([])
    data.append(FileFragmentConstants.FILE_TYPE_OPAQUE.value)
    data += butil.little_endian_32(total)
    data += butil.little_endian_32(offset)
    data += butil.little_endian_16(len(chunk))
    data += chunk
    return bytes(data)

def make_chlng_command(security_type: Enum = SecurityConstants.SCBK, sequence=0, use_crc: bool = False) -> Command:
    """
    Creates a client cryptogram command (CCRYPT) for secure channel establishment.
    """
    cmnd = CommandTags.CHLNG
    random_a = b'\xB0\xB1\xB2\xB3\xB4\xB5\xB6\xB7'
    security_type_byte = bytes([security_type.value])
    security_block = {'type': SecurityConstants.SCS_11.value, 'block': make_security_block(SecurityConstants.SCS_11.value, security_type_byte)}
    return Command(cmnd, random_a, sequence, security_block=security_block, use_crc=use_crc)

def make_scrypt_command(security_type: Enum = SecurityConstants.SCBK, cryptogram: bytes = None, sequence=1, use_crc: bool = False) -> Command:
    """
    Creates a server cryptogram command (SCRYPT) for secure channel establishment.
    """
    cmnd = CommandTags.SCRYPT
    security_type_byte = bytes([security_type.value])
    security_block = {'type': SecurityConstants.SCS_13.value, 'block': make_security_block(SecurityConstants.SCS_13.value, security_type_byte)}
    return Command(cmnd, cryptogram, sequence, security_block=security_block, use_crc=use_crc)

def make_scs_15_command(data: bytes, last_mac: bytes, encryption_dict: dict, sequence=2, use_crc: bool = False) -> Command:
    """
    Creates a secure poll command (SCS_15) for secure channel communication.
    """
    cmnd = CommandTags.POLL
    security_block = {'type': SecurityConstants.SCS_15.value, 'block': make_security_block(SecurityConstants.SCS_15.value)}
    return Command(cmnd, data, sequence, security_block=security_block, last_mac=last_mac, encryption_dict=encryption_dict, use_crc=use_crc)

def make_scs_17_command(data: bytes, mac_i: bytes, encryption_dict: dict, sequence=2, use_crc: bool = False) -> Command:
    """
    Creates a secure poll command (SCS_17) with encryption and MAC calculation.
    """
    cmnd = CommandTags.POLL
    security_block = {'type': SecurityConstants.SCS_17.value, 'block': make_security_block(SecurityConstants.SCS_17.value)}
    return Command(cmnd, data, sequence, security_block=security_block, last_mac=mac_i, encryption_dict=encryption_dict, encrypt_data=True, use_crc=use_crc)

def make_security_block(block_type: int, block_data: bytes = None) -> bytes:
    """
    Creates a security block for secure channel communication.
    """
    security_block = bytearray()
    if block_data is not None:
        block_length = 3
        security_block.append(block_length)
        security_block.append(block_type)
        security_block.append(block_data)
    else:
        security_block.append(2)  # Block length is 2 when there's no block_data
        security_block.append(block_type)
    return bytes(security_block)


def _make_control_block(sequence: int, use_crc: bool, use_security_block: bool) -> int:
    """
    Creates a control block for OSDP messages.
    """
    control_block = MessagingConstants.DEFAULT_CNTRL | sequence
    if use_security_block:
        control_block |= ControlBlockMasks.SCB_MASK
    if use_crc:
        control_block |= ControlBlockMasks.CRC_MASK
    return control_block


class CommandFactory:
    """
    Factory class to create OSDP commands based on CommandTags.
    """

    def __init__(self, use_crc: bool = False):
        self.command_creators: Dict[CommandTags, Callable[[int, int, Optional[bytes], bool], Command]] = {}
        self.use_crc = use_crc
        self.register_commands()

    def register_command(self, tag: CommandTags):
        """
        Decorator to register a command creation function.
        """
        def decorator(func: Callable[[int, int, Optional[bytes], bool], Command]):
            self.command_creators[tag] = func
            return func
        return decorator

    def create_command(self, tag: CommandTags, sequence: int, address: int, data: Optional[bytes] = None, security_type: Optional[SecurityConstants] = None) -> Command:
        if tag in self.command_creators:
            command = self.command_creators[tag](sequence, address, data, self.use_crc)
            if security_type:
                command.security_block = {'type': security_type.value, 'block': make_security_block(security_type.value)}
            return command
        else:
            raise ValueError(f"Unsupported command tag: {tag}")

    def register_commands(self):
        """
        Register all command creation functions.
        """
        @self.register_command(CommandTags.POLL)
        def create_poll_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            return Command(CommandTags.POLL, None, sequence, address, use_crc=use_crc)

        @self.register_command(CommandTags.ID)
        def create_id_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            ID_DATA = bytes([0x00])
            return Command(CommandTags.ID, ID_DATA, sequence, address, use_crc=use_crc)

        @self.register_command(CommandTags.CAP)
        def create_cap_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            CAP_DATA = bytes([0x00])
            return Command(CommandTags.CAP, CAP_DATA, sequence, address, use_crc=use_crc)

        @self.register_command(CommandTags.LSTAT)
        def create_lstat_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            return Command(CommandTags.LSTAT, None, sequence, address, use_crc=use_crc)

        @self.register_command(CommandTags.ISTAT)
        def create_istat_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            return Command(CommandTags.ISTAT, None, sequence, address, use_crc=use_crc)
        
        @self.register_command(CommandTags.OSTAT)
        def create_ostat_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            return Command(CommandTags.OSTAT, None, sequence, address, use_crc=use_crc)
        
        @self.register_command(CommandTags.RSTAT)
        def create_rstat_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            return Command(CommandTags.RSTAT, None, sequence, address, use_crc=use_crc)
        
        @self.register_command(CommandTags.OUT)
        def create_out_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            raise NotImplementedError("OUT command is not implemented yet")
        
        @self.register_command(CommandTags.LED)
        def create_led_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            data = make_perm_led_command(0x01, 0x03, 0x03, LEDCodes.LED_RED.value, LEDCodes.LED_RED.value)
            return Command(CommandTags.LED, data, sequence, address, use_crc=use_crc)
        
        @self.register_command(CommandTags.BUZ)
        def create_buz_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            raise NotImplementedError("BUZ command is not implemented yet")
        
        @self.register_command(CommandTags.COMSET)
        def create_comset_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            raise NotImplementedError("COMSET command is not implemented yet")
        
        @self.register_command(CommandTags.BIOREAD)
        def create_bioread_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            raise NotImplementedError("BIOREAD command is not implemented yet")
        
        @self.register_command(CommandTags.MFG)
        def create_mfg_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            if data is None:
                raise ValueError("Data is required for MFG commands")
            return Command(CommandTags.MFG, data, sequence, address, use_crc=use_crc)

        @self.register_command(CommandTags.FILETRANSFER)
        def create_file_transfer_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            if data is None:
                raise ValueError("Data is required for FILETRANSFER commands")
            return Command(CommandTags.FILETRANSFER, data, sequence, address, use_crc=use_crc)

        @self.register_command(CommandTags.KEYSET)
        def create_keyset_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            if data is None:
                raise ValueError("Data is required for KEYSET commands")
            KEY_TYPE = 0x01
            length = len(data)
            data = bytes([KEY_TYPE, length]) + data
            return Command(CommandTags.KEYSET, data, sequence, address, use_crc=use_crc)

        @self.register_command(CommandTags.ACURXSIZE)
        def create_acurxsize_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            raise NotImplementedError("ACURXSIZE command is not implemented yet")
        
        @self.register_command(CommandTags.XWR)
        def create_xwr_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            raise NotImplementedError("XWR command is not implemented yet")
        
        @self.register_command(CommandTags.ABORT)
        def create_abort_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            return Command(CommandTags.ABORT, None, sequence, address, use_crc=use_crc)
        
        @self.register_command(CommandTags.PIVDATA)
        def create_pivdata_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            raise NotImplementedError("PIVDATA command is not implemented yet")
        
        @self.register_command(CommandTags.GENAUTH)
        def create_genauth_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            raise NotImplementedError("GENAUTH command is not implemented yet")
        
        @self.register_command(CommandTags.CRAUTH)
        def create_crauth_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            raise NotImplementedError("CRAUTH command is not implemented yet")
        
        @self.register_command(CommandTags.MFGSTAT)
        def create_mfgstat_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            raise NotImplementedError("MFGSTAT command is not implemented yet")
        
        @self.register_command(CommandTags.KEEPACTIVE)
        def create_keepactive_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            raise NotImplementedError("KEEPACTIVE command is not implemented yet")


class SecureCommandFactory(CommandFactory):
    """
    Factory class to create secure OSDP commands based on CommandTags and SecurityConstants.
    """
    def __init__(self, scbk: SecurityConstants = SCBK_D_KEY, use_crc: bool = False):
        super().__init__(use_crc)
        self.scbk = scbk

    def create_secure_command(self, tag: CommandTags, sequence: int, address: int, data: Optional[bytes] = None, security_type: Optional[SecurityConstants] = None, encryption_dict: Optional[dict] = None, last_mac: Optional[bytes] = None, scbk: Optional[bytes] = None) -> Command:
        command = super().create_command(tag, sequence, address, data)
        if security_type:
            security_block = make_security_block(security_type.value)
            command.security_block = {'type': security_type.value, 'block': security_block}
        if security_type == SecurityConstants.SCS_17:
            command.encrypt_data = True
            command.encryption_dict = encryption_dict
        command.last_mac = last_mac
        return command

    def register_commands(self):
        super().register_commands()

        @self.register_command(CommandTags.CHLNG)
        def create_chlng_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            random_a = data if data is not None else b'\xb0\xb1\xb2\xb3\xb4\xb5\xb6\xb7'
            security_data = SecurityConstants.SCBK_D.value if self.scbk == SCBK_D_KEY else SecurityConstants.SCBK.value
            security_block = make_security_block(SecurityConstants.SCS_11.value, security_data)
            return Command(CommandTags.CHLNG, random_a, sequence, address, security_block=security_block, use_crc=use_crc)

        @self.register_command(CommandTags.SCRYPT)
        def create_scrypt_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            if data is None:
                raise ValueError("Data is required for SCRYPT commands")
            security_data = SecurityConstants.SCBK.value if self.scbk == SCBK_D_KEY else SecurityConstants.SCBK.value
            security_block = make_security_block(SecurityConstants.SCS_13.value, security_data)
            return Command(CommandTags.SCRYPT, data, sequence, address, security_block=security_block, use_crc=use_crc)

