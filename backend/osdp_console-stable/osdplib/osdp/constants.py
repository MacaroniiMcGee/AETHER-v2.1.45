"""
OSDP constants module.
Defines various constants and enumerations used in OSDP communication.
"""

from enum import IntEnum

# Messaging constants
class MessagingConstants(IntEnum):
    """
    Constants related to OSDP messaging.
    """
    SOM = 0x53
    DEFAULT_ADDR = 0
    DEFAULT_CNTRL = 0
    OVERHEAD = 7
    SQN = 0

# Command Tags
class CommandTags(IntEnum):
    """
    Tags representing various OSDP commands.
    """
    POLL = 0x60
    ID = 0x61
    CAP = 0x62
    LSTAT = 0x64
    ISTAT = 0x65
    OSTAT = 0x66
    RSTAT = 0x67
    OUT = 0x68
    LED = 0x69
    BUZ = 0x6A
    TEXT = 0x6B
    COMSET = 0x6E
    BIOREAD = 0x73
    BIOMATCH = 0x74
    KEYSET = 0x75
    CHLNG = 0x76
    SCRYPT = 0x77
    ACURXSIZE = 0x78
    FILETRANSFER = 0x7C
    MFG = 0x80
    XWR = 0xA1
    ABORT = 0xA2
    PIVDATA = 0xA3
    GENAUTH = 0xA4
    CRAUTH = 0xA5
    MFGSTAT = 0xA6
    KEEPACTIVE = 0xA7

# Response Tags
class ResponseTags(IntEnum):
    """
    Tags representing various OSDP responses.
    """
    ACK = 0x40
    NAK = 0x41
    PDID = 0x45
    PDCAP = 0x46
    LSTATR = 0x48
    ISTATR = 0x49
    OSTATR = 0x4A
    RSTATR = 0x4B
    RAW_CARD = 0x50
    FMT = 0x51
    KEYPAD = 0x53
    COM = 0x54
    BIOREADR = 0x57
    BIOMATCHR = 0x58
    CCRYPT = 0x76
    RMAC_I = 0x78
    FTSTAT = 0x7A
    PIVDATAR = 0x80
    GENAUTHR = 0x81
    CRAUTHR = 0x82
    MFGSTATR = 0x83
    MFGERRR = 0x84
    MFGREP = 0x90
    XRD = 0xB1

class NAKCodes(IntEnum):
    """
    NAK (Negative Acknowledgment) error codes.
    """
    NO_ERROR = 0x00
    MESSAGE_CHECKSUM_ERROR = 0x01
    COMMAND_LENGTH_ERROR = 0x02
    UNKNOWN_COMMAND = 0x03
    UNEXPECTED_HEADER = 0x04
    SECURITY_BLOCK_UNSUPPORTED = 0x05
    ENCRYPTION_REQUIRED = 0x06
    BIO_TYPE_UNSUPPORTED = 0x07
    BIO_FORMAT_UNSUPPORTED = 0x08
    UNABLE_TO_PROCESS = 0x09

# LED color codes
class LEDCodes(IntEnum):
    """
    LED color codes.
    """
    LED_BLACK = 0
    LED_RED = 1
    LED_GREEN = 2
    LED_AMBER = 3
    LED_BLUE = 4

# LED temp control codes
class LEDTempControlCodes(IntEnum):
    """
    LED temporary control codes.
    """
    LED_TEMP_NOOP = 0
    LED_TEMP_CANCEL = 1
    LED_TEMP_START = 2

# LED perm control codes
class LEDPermControlCodes(IntEnum):
    """
    LED permanent control codes.
    """
    LED_PERM_NOOP = 0
    LED_PERM_ENABLE = 1

# OSDP file fragment size
class FileFragmentConstants(IntEnum):
    """
    Constants related to file transfer fragments.
    """
    FILE_FRAGMENT_MAX = 128-18 # MAX_PACKET_SIZE - OSDP_OVERHEAD
    FILE_TYPE_OPAQUE = 1

# File Transfer status
class FileTransferStatus(IntEnum):
    """
    File transfer status codes.
    """
    FT_OK = 0
    FT_PROCESSED = 1
    FT_REBOOTING = 2
    FT_FINISHING = 3

# Control block masks
class ControlBlockMasks(IntEnum):
    """
    Masks for control block flags.
    """
    SQN_MASK = 0x03
    CRC_MASK = 0x04  # Set this mask for CRC, don't set for checksum
    SCB_MASK = 0x08  # Set this mask if security block is present

# Security constants
class SecurityConstants(IntEnum):
    """
    Security-related constants.
    """
    SCBK = 0x01
    SCBK_D = 0x00
    S_ENC_KEY_TYPE = 0x82
    S_MAC1_KEY_TYPE = 0x01
    S_MAC2_KEY_TYPE = 0x02
    SCS_11 = 0x11
    SCS_13 = 0x13
    SCS_15 = 0x15
    SCS_16 = 0x16
    SCS_17 = 0x17
    SCS_18 = 0x18

class FunctionCodes(IntEnum):
    """
    Function codes for secure channel.
    """
    CONTACT_STATUS_MONITORING = 1
    OUTPUT_CONTROL = 2
    CARD_DATA_FORMAT = 3
    READER_LED_CONTROL = 4
    READER_AUDIBLE_OUTPUT = 5
    READER_TEST_OUTPUT = 6
    TIME_KEEPING = 7
    CHECK_CHARACTER_SUPPORT = 8
    COMMUNICATION_SECURITY = 9
    RECEIVE_BUFFER_SIZE = 10
    LARGEST_COMBINED_MESSAGE_SIZE = 11
    SMART_CARD_SUPPORT = 12
    READERS = 13
    BIOMETRICS = 14
    SECURE_PIN_ENTRY_SUPPORT = 15
    OSDP_VERSION = 16

class TamperStatus(IntEnum):
    """
    Tamper status codes. LSTATR
    """
    NORMAL = 0
    TAMPER_ACTIVE = 1

class PowerStatus(IntEnum):
    """
    Power status codes. LSTATR
    """
    NORMAL = 0
    POWER_FAILURE = 1

def from_enum(enum, value):
    """
    Convert a value to its corresponding enum member, if possible.
    """
    return enum(value) if value in enum.__members__.values() else value

# Manufacturer-specific OIDs and keys
MFG_OID: bytes = bytes([0x5C, 0x26, 0x23])
MFG_WL_ID: bytes = bytes([0x57])
SCBK_D_KEY = b'\x30\x31\x32\x33\x34\x35\x36\x37\x38\x39\x3A\x3B\x3C\x3D\x3E\x3F'
SCBK_KEY_2 = b'\x40\x41\x42\x43\x44\x45\x46\x47\x48\x49\x4A\x4B\x4C\x4D\x4E\x4F'
