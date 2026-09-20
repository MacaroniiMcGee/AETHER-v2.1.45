#!/usr/bin/python3
"""
byteutil.py
Author: Taylor Schmidt

Byte manipulation utils.
"""


def little_endian_32(indata: int) -> bytes:
    """
    Get a little endian 32 bit byte array from an int.
    """
    return bytes(
        [
            indata & 0xFF,
            (indata & 0xFF00) >> 8,
            (indata & 0xFF0000) >> 16,
            (indata & 0xFF000000) >> 24,
        ]
    )


def little_endian_16(indata: int) -> bytes:
    """
    Get a little endian 16 bit byte array from an int.
    """
    return bytes([indata & 0xFF, (indata & 0xFF00) >> 8])


def parse_little_endian_16(indata: bytes) -> int:
    """
    Parse a little endian 16 bit byte array into an int.
    """
    return indata[0] | (indata[1] << 8)
