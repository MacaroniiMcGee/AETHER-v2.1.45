import logging
from typing import Optional, Tuple, List, Dict, Callable
from enum import Enum
from osdplib import byteutil as butil
from .constants import MessagingConstants, ResponseTags, FunctionCodes, TamperStatus, PowerStatus, ControlBlockMasks, SecurityConstants, NAKCodes, from_enum
from .utils import calc_mac, decrypt, ones_complement
from ..card_technologies import get_card_technology_name_for_data

class Response:
    """
    Represents a response from an OSDP device.
    """

    class Capabilities:
        """
        Represents the capabilities of an OSDP device.
        """
        
        def __init__(self):
            self.capabilities = []

        def add_capability(self, function_enum: Enum, compliance: int, num_items: int):
            self.capabilities.append((function_enum, compliance, num_items))

        def __repr__(self) -> str:
            capabilities_repr = [
                f'  --- {function_enum.name} ({hex(function_enum.value)}), COMPLIANCE: {compliance}, NUM_ITEMS: {num_items}'
                for function_enum, compliance, num_items in self.capabilities
            ]
            return '\n' + '\n'.join(capabilities_repr)

    def __init__(self, raw: bytes, s_key_dict: Optional[dict] = None):
        self.raw = raw
        self.pointer = 0
        self.s_key_dict = s_key_dict if s_key_dict is not None else {}
        self.has_mac = False
        self.security_block_length = None
        self.security_block_type = None
        self.security_block_data = None
        self.code = None
        self.error_code = None
        self.data = None
        self.mac = None
        self.client_id = None
        self.random_number_b = None
        self.cryptogram = None
        self.rmac_i = None
        self.capabilities = None
        self._wrapped = False
        self.computed_mac = None

        self.som = self._parse_byte()
        self.address = self._parse_byte()
        self.length = self._parse_length()
        self.control = self._parse_byte()
        self.sequence, self.use_crc, self.use_security_block = parse_control_block(self.control)

        if self.use_security_block:
            self._parse_security_block()
            if self.security_block_type in {SecurityConstants.SCS_16, SecurityConstants.SCS_18}:
                self.has_mac = True
                self._wrapped = True

        self.code = self._parse_byte()
        self.code = from_enum(ResponseTags, self.code)

        if self.code == ResponseTags.NAK:
            self.error_code = self._parse_byte()
            self.error_code = from_enum(NAKCodes, self.error_code)

        self.data = self._parse_data()

        if self._wrapped:
            self.unwrap() # unwrap sets self.mac for SCS_18 messages, computes mac.

        if self.has_mac:
            self.mac = self._parse_mac()

        if self.computed_mac is not None:
            self.check_mac()

        self.cksum_crc = self._parse_cksum_crc()

    def _parse_byte(self) -> int:
        byte = self.raw[self.pointer]
        self.pointer += 1
        return byte

    def _parse_bytes(self, num_bytes) -> bytes:
        data = self.raw[self.pointer:self.pointer + num_bytes]
        self.pointer += num_bytes
        return data

    def _parse_length(self) -> int:
        len_lsb = self._parse_byte()
        len_msb = self._parse_byte()
        return (len_msb << 8) + len_lsb

    def _parse_security_block(self):
        self.security_block_length = self._parse_byte()
        self.security_block_type = self._parse_byte()

        if self.security_block_length > 2:
            self.security_block_data = self.raw[self.pointer:self.pointer + self.security_block_length - 2]
            self.pointer += self.security_block_length - 2
        else:
            self.security_block_data = bytearray()

    def _parse_data(self, data = None) -> bytes:
        if data is None:
            data_length = self.length - self.pointer - (2 if self.use_crc else 1)
            data_length -= 4 if self.has_mac else 0
            if data_length > 0:
                data = self.raw[self.pointer:self.pointer + data_length]
                parser = self._get_data_parser(self.code)
                if parser:
                    parser(data)
                return data
            return bytearray()
        # we have data passed in, but no specific parser for the data
        # parse the data in a generic way
        else:
            parser = self._get_data_parser(self.code)
            if parser:
                return parser(data)
            # no parser means we need to increment pointer by the length of the data here
            self.pointer += len(data)
            return data
    def _get_data_parser(self, code: ResponseTags) -> Optional[Callable[[bytes], None]]:
        """
        Dispatches the data parsing to the appropriate method based on the response code.
        """
        return {
            ResponseTags.CCRYPT: self._parse_ccrypt_data,
            ResponseTags.RMAC_I: self._parse_rmac_i_data,
            ResponseTags.PDID: self._parse_pdid_data,
            ResponseTags.PDCAP: self._parse_pdcap_data,
            ResponseTags.LSTATR: self._parse_lstatr_data,
            ResponseTags.RAW_CARD: self._parse_raw_data,
            ResponseTags.FTSTAT: self._parse_fstat_data,
        }.get(code, None)

    def _parse_raw_data(self, data: bytes):
        """
        Parses card data for the OSDP_RAW response and sets the card technology if the card data is known.
        """
        logging.info(f"Parsing raw card data: {data.hex()}")
        self._card_header = self._parse_bytes(4)
        # the rest of the data is the card data
        self.card_data = self._parse_bytes(len(data) - 4).hex()
        # if card data is found in our list of known card data, let's set the card technology
        self.card_technology = get_card_technology_name_for_data(data=self.card_data)
        return data

    def _parse_ccrypt_data(self, data: bytes):
        self.client_id = self._parse_bytes(8)
        self.random_number_b = self._parse_bytes(8)
        self.cryptogram = self._parse_bytes(16)

    def _parse_rmac_i_data(self, data: bytes):
        self.rmac_i = self._parse_bytes(16)

    def _parse_pdid_data(self, data: bytes):
        self._vendor_code_1 = self._parse_byte()
        self._vendor_code_2 = self._parse_byte()
        self._vendor_code_3 = self._parse_byte()
        self.vendor_code = (self._vendor_code_1 << 16) + (self._vendor_code_2 << 8) + self._vendor_code_3
        self.model_number = self._parse_byte()
        self.version = self._parse_byte()
        self._serial_number_1 = self._parse_byte()  # LSB
        self._serial_number_2 = self._parse_byte()
        self._serial_number_3 = self._parse_byte()
        self._serial_number_4 = self._parse_byte()  # MSB
        self.serial_number = (self._serial_number_1 << 24) + (self._serial_number_2 << 16) + (self._serial_number_3 << 8) + self._serial_number_4
        self._firmware_major = self._parse_byte()
        self._firmware_minor = self._parse_byte()
        self._firmware_build = self._parse_byte()
        self.firmware_version = f'{self._firmware_major}.{self._firmware_minor}.{self._firmware_build}'

    def _parse_pdcap_data(self, data: bytes):
        number_of_records = len(data) // 3
        # assert len(data) % 3 == 0, f"Invalid PDCAP data length. Data should be a multiple of 3 bytes: {data}"
        self.capabilities = self.Capabilities()
        for _ in range(number_of_records):
            function_code = self._parse_byte()
            function_enum = from_enum(FunctionCodes, function_code)
            compliance = self._parse_byte()
            num_items = self._parse_byte()
            self.capabilities.add_capability(function_enum, compliance, num_items)

    def _parse_lstatr_data(self, data: bytes):
        self.tamper_status = self._parse_byte()
        self.tamper_status = from_enum(TamperStatus, self.tamper_status)
        self.power_status = self._parse_byte()
        self.power_status = from_enum(PowerStatus, self.power_status)

    def _parse_fstat_data(self, data: bytes):
        # self.delay = butil.parse_little_endian_16(data[1:])
        # self.status = butil.parse_little_endian_16(data[3:])
        # redo the above with self._parse_byte() and self._parse_bytes(2) and self._parse_bytes(2)
        self.ft_action = self._parse_byte()
        self._ft_dealy_lsb = self._parse_byte()
        self._ft_dealy_msb = self._parse_byte()
        self.ft_delay = (self._ft_dealy_msb << 8) + self._ft_dealy_lsb
        self._ft_status_lsb = self._parse_byte()
        self._ft_status_msb = self._parse_byte()
        self.ft_status = (self._ft_status_msb << 8) + self._ft_status_lsb
        # convert ft_status to a signed integer
        if self.ft_status > 0x7FFF:
            self.ft_status = -((self.ft_status ^ 0xFFFF) + 1)
        self._ft_update_msg_max_lsb = self._parse_byte()
        self._ft_update_msg_max_msb = self._parse_byte()
        self.ft_update_msg_max = (self._ft_update_msg_max_msb << 8) + self._ft_update_msg_max_lsb

    def _parse_cksum_crc(self) -> Optional[int]:
        if self.use_crc:
            cksum_crc = int.from_bytes(self.raw[self.length - 2:self.length], 'little')
        else:
            cksum_crc = self.raw[self.length - 1]
        return cksum_crc

    def _parse_mac(self) -> bytes:
        mac = self.raw[self.pointer:self.pointer + 4]
        self.pointer += 4
        
        return mac
    
    def unwrap(self) -> None:
        if self.security_block_type == SecurityConstants.SCS_16:
            self.computed_mac = calc_mac(self.raw[:self.pointer], self.s_key_dict['s_mac1'], self.s_key_dict['s_mac2'], self.s_key_dict['mac_i'])
            return

        assert self.security_block_type == SecurityConstants.SCS_18, f"Invalid security block type for unwrap operation: {self.security_block_type}"
        # remove the mac
        start_of_data = self.pointer
        end_of_data = self.length - 5
        end_of_data -= 1 if self.use_crc else 0
        raw_for_mac = self.raw[:end_of_data]

        logging.debug(f"Calculating MAC for message: {raw_for_mac.hex()}")
        logging.debug(f"s_mac1: {self.s_key_dict['s_mac1'].hex()}")
        logging.debug(f"s_mac2: {self.s_key_dict['s_mac2'].hex()}")
        logging.debug(f"mac_i: {self.s_key_dict['mac_i'].hex()}")
        self.computed_mac = calc_mac(raw_for_mac, self.s_key_dict['s_mac1'], self.s_key_dict['s_mac2'], self.s_key_dict['mac_i'])
        self.pointer += (end_of_data - start_of_data)

        # decrypt the data
        mac_ones_compliment = ones_complement(self.s_key_dict['mac_i'])
        logging.debug(f"Decrypting data with mac_ones_compliment: {mac_ones_compliment.hex()}")
        logging.debug(f"Encrypted data: {self.data.hex()}")
        logging.debug(f"s_enc: {self.s_key_dict['s_enc'].hex()}")
        decrypted_data = decrypt(self.s_key_dict['s_enc'], self.data, mac_ones_compliment)
        logging.debug(f"Decrypted data {decrypted_data.hex()}")
        self.data = decrypted_data

        # before we can reparse the data, we need to reset the pointer to the start of the data, and replace the encrypted data with the decrypted data in the raw message.
        self.pointer = start_of_data
        self.raw = self.raw[:start_of_data] + decrypted_data + self.raw[end_of_data:]
        self.length = len(self.raw)
        self._parse_data(data=self.data)

    def check_mac(self) -> None:
        """Check if the first 4 bytes of the computed mac match the received mac."""
        assert self.mac == self.computed_mac[:4], f"MAC mismatch, Recieved MAC: {self.mac.hex()} != Calculated MAC: {self.computed_mac[:4].hex()}\n{self}"
        logging.debug(f"MAC check passed")
        
    def __repr__(self) -> str:
        excluded_keys = {'raw', 'pointer', 'som', 'use_security_block', 'use_crc', 'has_mac', 'RMAC_I', 's_key_dict'}
        ordered_keys = ['code', 'address', 'length', 'control', 'sequence', 'security_block_length', 'security_block_type', 'security_block_data', 'data',
                        'tamper_status', 'power_status', 'capabilities', 'rmac_i', 'cksum_crc']

        attrs = {key: value for key, value in vars(self).items() if not key.startswith('_') and value is not None and (key != 'data' or value)}

        ordered_attrs_repr = [
            f'  - {key.upper()}: {attrs[key].name} ({hex(attrs[key].value)})' if isinstance(attrs[key], Enum)
            else f'  - {key.upper()}: {hex(attrs[key])}' if isinstance(attrs[key], int)
            else f'  - {key.upper()}: {attrs[key].hex()}' if isinstance(attrs[key], (bytes, bytearray))
            else f'  - {key.upper()}: {attrs[key]}'
            for key in ordered_keys if key in attrs and key not in excluded_keys and (key != 'security_block' or attrs[key])
        ]

        remaining_attrs_repr = [
            f'  - {key.upper()}: {value.name} ({hex(value.value)})' if isinstance(value, Enum)
            else f'  - {key.upper()}: {hex(value)}' if isinstance(value, int)
            else f'  - {key.upper()}: {value.hex()}' if isinstance(value, (bytes, bytearray))
            else f'  - {key.upper()}: {value}'
            for key, value in attrs.items() if key not in ordered_keys and key not in excluded_keys and value is not None
        ]

        attrs_repr = '\n'.join(ordered_attrs_repr + remaining_attrs_repr)
        return f"Response:\n{attrs_repr}\n"

    def get_data(self) -> bytes:
        return self.data

    def hex(self) -> str:
        return self.raw.hex()

def parse_response(raw: bytes, s_key_dict: Optional[dict] = None, wrapped: Optional[bool] = False) -> Optional[Response]:
    if len(raw) < MessagingConstants.OVERHEAD:
        return None

    cleaned = raw
    while cleaned[0] != MessagingConstants.SOM:
        cleaned = cleaned[1:]

    if len(cleaned) < MessagingConstants.OVERHEAD:
        return None

    response = Response(cleaned, s_key_dict)
    return response

def parse_control_block(control: int) -> Tuple[int, bool, bool]:
    sequence = control & ControlBlockMasks.SQN_MASK
    use_crc = bool(control & ControlBlockMasks.CRC_MASK)
    use_security_block = bool(control & ControlBlockMasks.SCB_MASK)
    return sequence, use_crc, use_security_block

def parse_card_data(data: bytes) -> Tuple[int, bytes]:
    num_bits = data[2] | (data[3] << 8)
    bitstream = data[4:]
    return num_bits, bitstream

def parse_tamper_data(data: bytes) -> bool:
    return data[0] == TamperStatus.TAMPER_ACTIVE.value

# def parse_ftstat(data: bytes) -> Tuple[int, int]:
#     delay: int = butil.parse_little_endian_16(data[1:])
#     status: int = butil.parse_little_endian_16(data[3:])
#     return status, delay
