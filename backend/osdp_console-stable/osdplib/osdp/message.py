# message.py

class Message:
    def __init__(self, raw: bytes = None, encryption_dict: dict = None):
        self.raw = raw
        self.pointer = 0
        self.address = None
        self.length = None
        self.control = None
        self.sequence = None
        self.use_crc = False
        self.use_security_block = False
        self.security_block_length = None
        self.security_block_type = None
        self.security_block_data = None
        self.cksum_crc = None
        self.som = None
        self.encryption_dict = encryption_dict if encryption_dict else {}
        self.mac = None

        if raw:
            self.parse_message()

    def parse_message(self):
        """
        Parses the common elements from the message, such as SOM, address, length, control block, etc.
        """
        self.som = self._parse_byte()
        self.address = self._parse_byte()
        self.length = self._parse_length()
        self.control = self._parse_byte()
        self.sequence, self.use_crc, self.use_security_block = self.parse_control_block(self.control)

        if self.use_security_block:
            self._parse_security_block()

    def build_message(self):
        """
        Builds the common structure of the message, such as SOM, address, length, control block, etc.
        """
        self.raw = bytearray()
        self.raw.append(MessagingConstants.SOM)
        self.raw.append(self.address)
        self._append_message_length()
        self.raw.append(self.control)

        if self.use_security_block:
            self._append_security_block()

    def calculate_mac(self, mac_i: bytes) -> bytes:
        """
        Calculates the MAC for the current message.
        """
        padded_message = self.raw + b'\x80'
        while len(padded_message) % 16 != 0:
            padded_message += b'\x00'
        mac_length = 4  # we'll only send the first 4 bytes of the MAC

        mac = mac_i  # Initialize with the previously sent MAC
        for i in range(0, len(padded_message), 16):
            block = padded_message[i:i + 16]
            if i == len(padded_message) - 16:
                mac = encrypt(self.encryption_dict.get('s_mac2'), block, mode=AES.MODE_CBC, iv=mac)
            else:
                mac = encrypt(self.encryption_dict.get('s_mac1'), block, mode=AES.MODE_CBC, iv=mac)
        self.mac = mac  # this will be used as the next ICV
        return mac[:mac_length]

    def verify_mac(self, received_mac: bytes, mac_i: bytes) -> bool:
        """
        Verifies if the received MAC matches the computed MAC for the message.
        """
        computed_mac = self.calculate_mac(mac_i)
        return received_mac == computed_mac

    def _parse_byte(self) -> int:
        byte = self.raw[self.pointer]
        self.pointer += 1
        return byte

    def _parse_bytes(self, num_bytes: int) -> bytes:
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
            self.security_block_data = self._parse_bytes(self.security_block_length - 2)
        else:
            self.security_block_data = bytearray()

    def parse_control_block(self, control: int):
        """
        Parses the control block to extract sequence, CRC usage, and security block usage.
        """
        sequence = control & ControlBlockMasks.SQN_MASK
        use_crc = bool(control & ControlBlockMasks.CRC_MASK)
        use_security_block = bool(control & ControlBlockMasks.SCB_MASK)
        return sequence, use_crc, use_security_block

    def _append_message_length(self):
        """
        Appends the length of the message to the message bytearray.
        """
        len_lsb = self.length & 0xFF
        len_msb = (self.length & 0xFF00) >> 8
        self.raw.append(len_lsb)
        self.raw.append(len_msb)

    def _append_security_block(self):
        """
        Appends the security block to the message if present.
        """
        self.raw.append(self.security_block_length)
        self.raw.append(self.security_block_type)
        if self.security_block_length > 2:
            self.raw += self.security_block_data

# command.py



# response.py

