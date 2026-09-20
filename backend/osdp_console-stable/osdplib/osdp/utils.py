# utils.py
import crcmod
from Crypto.Cipher import AES
import logging

def calc_checksum(message: bytes) -> int:
    """
    Calculates the checksum for an OSDP message.
    """
    checksum = 0
    for byte in message:
        checksum = (checksum + byte) & 0xFF
    return ((~checksum) + 1) & 0xFF

def crc_to_little_endian(crc: int) -> int:
    """
    Convert CRC to little-endian format.
    """
    return ((crc & 0xFF) << 8) | ((crc >> 8) & 0xFF)

def calc_crc(message: bytes) -> int:
    """
    Calculates the CRC for an OSDP message.
    """
    crc16_ccitt = crcmod.mkCrcFun(0x11021, initCrc=0x1D0F, rev=False, xorOut=0x0000)
    crc = crc16_ccitt(message)
    return crc_to_little_endian(crc)

def calc_cryptogram(random_a: bytes, random_b: bytes, s_enc: bytes) -> bytes:
    """
    Calculate the cryptogram for secure channel initialization.
    """
    random_ab = random_a + random_b
    assert len(random_ab) == 16, "Random A and B must be 16 bytes long"

    cryptogram = encrypt(s_enc, random_ab)
    return cryptogram

def calc_mac(message: bytes, s_mac1: bytes, s_mac2: bytes, mac_i: bytes) -> bytes:
    """
    Calculate the MAC (Message Authentication Code) for a given message.
    """
    padded_message = message + b'\x80'
    while len(padded_message) % 16 != 0:
        padded_message += b'\x00'

    mac = mac_i
    for i in range(0, len(padded_message), 16):
        block = padded_message[i:i + 16]
        if i == len(padded_message) - 16:
            mac = encrypt(s_mac2, block, mode=AES.MODE_CBC, iv=mac)
        else:
            mac = encrypt(s_mac1, block, mode=AES.MODE_CBC, iv=mac)
    return mac

def encrypt(key, data, mode=AES.MODE_ECB, iv=None):
    """
    Encrypts the data using AES encryption with the given key.
    
    :param key: The encryption key (must be 16, 24, or 32 bytes long)
    :param data: The data to encrypt (bytes, must be a multiple of 16 bytes in length)
    :param mode: The encryption mode (default is AES.MODE_ECB)
    :param iv: Initialization vector (IV) for modes that require it, can be a hex string or bytes
    :return: The encrypted data (bytes)
    """
    if isinstance(key, str):
        key = bytes.fromhex(key)  # Convert hex key back to bytes if necessary
    if isinstance(iv, str):
        iv = bytes.fromhex(iv)  # Convert hex IV back to bytes if necessary
    assert len(key) in [16, 24, 32], "Key length must be 16, 24, or 32 bytes"
    assert len(data) % 16 == 0, "Data length must be a multiple of 16 bytes"

    # Create a new AES cipher object based on the provided mode and iv
    if iv:
        cipher = AES.new(key, mode, iv)
    else:
        cipher = AES.new(key, mode)

    # Encrypt the data
    encrypted_data = cipher.encrypt(data)
    return encrypted_data

def decrypt(key, data, icv=None):
    """
    Decrypts the data using AES encryption with the given key.
    
    :param key: The encryption key (must be 16, 24, or 32 bytes long, can be hex string or bytes)
    :param data: The data to decrypt (bytes, must be a multiple of 16 bytes in length)
    :param icv: The initialization vector (bytes, must be 16 bytes long, can be hex string or bytes)
    :return: The decrypted data (bytes)
    """
    if isinstance(key, str):
        key = bytes.fromhex(key)  # Convert hex string to bytes if necessary
    if icv and isinstance(icv, str):
        icv = bytes.fromhex(icv)  # Convert hex string to bytes if necessary

    # Ensure the key is 16, 24, or 32 bytes long
    assert len(key) in [16, 24, 32], "Key length must be 16, 24, or 32 bytes"

    # Ensure the data length is a multiple of 16 bytes
    assert len(data) % 16 == 0, "Data length must be a multiple of 16 bytes"


    # Create a new AES cipher object
    cipher = AES.new(key, AES.MODE_CBC, iv=icv)

    # Decrypt the data
    decrypted_data = cipher.decrypt(data)
    logging.debug(f"Raw decrypted data: {decrypted_data.hex()}")

    # trim the end padding, 0x00 and then finally one 0x80
    decrypted_data = decrypted_data.rstrip(b'\x00')

    # the last byte should be 0x80
    if decrypted_data[-1] == 0x80:
        decrypted_data = decrypted_data[:-1]
    else:
        logging.error(f"Invalid padding in decrypted data: {decrypted_data.hex()}")
        raise ValueError("Invalid padding in decrypted data")

    return decrypted_data

def ones_complement(byte_array):
    # Create a new bytearray to store the one's complement
    complement = bytearray()
    
    # Iterate through each byte in the input bytearray
    for byte in byte_array:
        # Apply bitwise NOT and mask with 0xFF to get the one's complement of the byte
        complement.append(~byte & 0xFF)
    
    return complement
