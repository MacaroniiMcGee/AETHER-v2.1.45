#!/usr/bin/env python3
"""
ibeaconconf.py
Author: Taylor Schmidt

Configuration module for creating OSDP ibeacon message payloads.
"""
from typing import Optional
import base64
import hashlib

###############################################################################
#
# This script gives examples of how to generate an iBeacon configuration block
# used by WaveLynx Ethos/Fusion readers. This block will be embedded within
# an OSDP mfg message.
#
# This is the iBeacon config packet structure:
#
# | Field             | Length | Description                                  |
# |-------------------+--------+----------------------------------------------|
# | TAG               |      1 | ~0xB0~                                       |
# | LENGTH            |      1 | 0 - 84                                       |
# | IBEACON ENABLED   |      1 | 0 - disabled, 1 - enabled                    |
# | TRIGGER TIME      |      2 | trigger interval in ms *big endian*          |
# | PDU 1 TAG         |      1 | ~0xB1~                                       |
# | PDU 2 LENGTH      |      1 | Length of PDU 1                              |
# | PDU 1             | 0 - 31 | Advertisement data 1                         |
# | PDU CONFIG TAG    |      1 | ~0xB2~                                       |
# | PDU CONFIG LENGTH |      1 | ~0x04~                                       |
# | PDU 1 INTERVAL    |      2 | Advertising interval in ms *big endian*      |
# | PDU 1 TX          |      1 | Transmit Power (see TX settings)             |
# | PDU 1 CHANNELS    |      1 | Advertising channels (see channel bitmask)   |
# | PDU 2 TAG         |      1 | ~0xB1~                                       |
# | PDU 2 LENGTH      |      1 | Length of PDU 1                              |
# | PDU 2             | 0 - 31 | Advertisement data 1                         |
# | PDU CONFIG TAG    |      1 | ~0xB2~                                       |
# | PDU CONFIG LENGTH |      1 | ~0x04~                                       |
# | PDU 2 INTERVAL    |      2 | Advertising interval in ms *big endian*      |
# | PDU 2 TX          |      1 | Transmit Power (see TX settings)             |
# | PDU 2 CHANNELS    |      1 | Advertising channels (see channel bitmask)   |
# | CRC               |      2 | *Big endian*                                 |
#
#
# This is the OSDP mfg message structure the config block will be embedded in:
#
# 53000 [2 byte length] 0080
# 252357
# 57 [ 0 - 86 bytes config block]
# [1 byte OSDP Checksum]
#
#
###############################################################################

###############################################################################
#
# MODIFY THE FIELDS BELOW TO CHANGE THE CONFIG DATA
#
###############################################################################

# Enable flag for iBeacon advertising.
# Values: 0x00 => disabled
#         0x01 => touch enabled
#         0x02 => "*" key enabled
#         0x03 => Both enabled
ibeacon_enabled = 0x07

# Trigger interval. This determines the number of ms beacon 2 will be
# advertised for.
# Values: 0x0000 to 0x4E20 (20,000 ms)
trigger_interval = [0x13, 0x88]

########################################
#
# The following fields have config variables for both beacon 1 and beacon 2
#
########################################

# Beacon advertiement packets. This contains the raw advertising data and
# is up to the host to provide the correct iBeacon format. The individual
# fields have been clarified here for demo iBeacons.
#
# NOTE: Whatever data is placed in these fields will be advertised, even
#       if it is not in iBeacon format. It is up to the host to validate
#       the PDU structures.
#
# Values: 0-31 bytes of advertisement data

pdu1 = [
    0x02,  # header
    0x01,
    0x06,
    0x05,  # local name
    0x09,
    0x45,
    0x54,
    0x48,
    0x53,
    0x11,  # svc uuid
    0x07,
    0x9F,
    0xDC,
    0x9C,
    0x81,
    0xFF,
    0xFE,
    0x7F,
    0xBF,
    0xE5,
    0x11,
    0x2C,
    0xAF,
    0x1A,
    0xD8,
    0x20,
    0x34,
]

pdu2 = [
    0x02,  # header
    0x01,
    0x06,
    0x05,  # local name
    0x09,
    0x45,
    0x54,
    0x48,
    0x53,
    0x11,  # svc uuid
    0x07,
    0xFD,
    0x7D,
    0x0F,
    0xC0,
    0xE0,
    0x15,
    0xAE,
    0x9E,
    0xAD,
    0x4C,
    0xAD,
    0x0B,
    0x09,
    0x97,
    0xB5,
    0x2B,
]

# Beacon 1 advertising interval (how often a advertisment is broadcasted).
# Values: 0x0001 to 0x2710 (10,000 ms)
pdu1_interval = [0x00, 0x64]
pdu2_interval = [0x00, 0x64]

# Beacon TX power.
# Values:
#   0x00: -18 dBm
#   0x01: -12 dBm
#   0x02:  -6 dBm
#   0x03:  -3 dBm
#   0x05:  -2 dBm
#   0x06:  -1 dBm
#   0x07:   0 dBm
pdu1_txpower = 0x03
pdu2_txpower = 0x03

# Beacon advertisement channels.
# Values (BITMASK):
#   0x01: Ch. 37
#   0x02: Ch. 38
#   0x04: Ch. 39
pdu1_channels = 0x07
pdu2_channels = 0x07


def crc16(data, startval=0x6363):
    """
    CRC 16 CCITT function.

    Params:
     - data (list): data to calc crc over.

    Returns:
    - (list) big endian 16 representation of the crc.
    """
    crc = startval

    for byte in data:
        b = byte ^ (crc & 0xFF)
        b ^= (b << 4) & 0xFF

        c1 = (b << 8) & 0xFFFF
        c2 = (crc >> 8) & 0xFF
        c3 = (b >> 4) & 0xFF
        c4 = (b << 3) & 0xFFFF

        c12 = (c1 | c2) & 0xFFFF
        c34 = (c3 ^ c4) & 0xFFFF

        crc = (c12 ^ c34) & 0xFFFF

    return [(crc & 0xFF00) >> 8, crc & 0xFF]


def gen_name_from_serial(serial: bytes) -> bytes:
    """
    Generate a 4 character derived name for a given serial number based on WL
    specification.
    """
    hasher = hashlib.sha256()
    hasher.update(serial)
    sn_hash = hasher.digest()
    sn_hash_b64 = base64.b64encode(sn_hash)
    return sn_hash_b64[:4]


def make_config_block(adv_name: Optional[bytes]):
    """
    Creates the osdp payload based on the settings of this module.
    """

    # make the config block (combine all of the vars above).
    # *See table above for structure definition*
    config = []

    config.append(0xB0)  # tag
    config.append(0x00)  # length (0 placeholder for now)

    config.append(ibeacon_enabled)
    config += trigger_interval

    # beacon 1 data
    config.append(0xB1)  # pdu tag
    config.append(len(pdu1))  # pdu 1 length
    if adv_name:
        pdu1_name = pdu1.copy()
        pdu1_name[5] = adv_name[0]
        pdu1_name[6] = adv_name[1]
        pdu1_name[7] = adv_name[2]
        pdu1_name[8] = adv_name[3]
        config += pdu1_name
    else:
        config += pdu2

    config += pdu1

    # beacon 1 config
    config.append(0xB2)  # pdu config tag
    config.append(4)  # fixed config length
    config += pdu1_interval
    config.append(pdu1_txpower)
    config.append(pdu1_channels)

    # beacon 2 data
    config.append(0xB1)  # pdu tag
    config.append(len(pdu2))  # pdu 2 length
    if adv_name:
        pdu2_name = pdu2.copy()
        pdu2_name[5] = adv_name[0]
        pdu2_name[6] = adv_name[1]
        pdu2_name[7] = adv_name[2]
        pdu2_name[8] = adv_name[3]
        config += pdu2_name
    else:
        config += pdu2

    # beacon 2 config
    config.append(0xB2)  # pdu config tag
    config.append(4)  # fixed config length
    config += pdu2_interval
    config.append(pdu2_txpower)
    config.append(pdu2_channels)

    # calculate the crc and append it to the config.
    # The crc covers the entire "value" field of the config
    # block, which excludes the first tag and length bytes.
    config += crc16(config[2:])

    # Populate the final length field for the entire payload.
    # The length field includes the last 2 crc bytes which were added (but not
    # the first 2 tag and length byted).
    config[1] = len(config) - 2

    return config


if __name__ == "__main__":
    print("-------- Ethos iBeacon Config Generator --------")
    conf = make_config_block()
    print("Config block: " + bytes(conf).hex().upper())
