#!/usr/bin/python3

"""
osdpdevice.py
Author: Taylor Schmidt

OSDP serial device and command builder.
"""

import logging
from typing import Optional, Dict, Callable
from enum import IntEnum
from osdplib import osdp, comms
from osdplib.osdp import Command, Response
from osdplib.osdp import CommandTags, MessagingConstants


class OsdpDevice(comms.Device):
    """
    Object holder for OSDP device specific state.
    """

    def __init__(self,
                 port: str,
                 baud_rate: int = 9600,
                 address: int = MessagingConstants.DEFAULT_ADDR,
                 use_crc: bool = False):
        """
        Init the OSDP serial connection, address, and message sequence.
        
        Args:
            port (str): The serial port to which the OSDP device is connected.
            baud_rate (int): The baud rate for the serial communication.
            address (int): The address of the OSDP device.
            use_crc (bool): Whether to use CRC for message integrity.
        """
        super().__init__(port, baud_rate)
        self.address = address
        self.command_factory = CommandFactory(use_crc=use_crc)
        self.use_crc = use_crc

    def send(self, tag: CommandTags, sequence: int, data: Optional[bytes] = None) -> Response:
        """
        General method to send any command.
        
        Args:
            tag (CommandTags): The command tag indicating the type of command.
            sequence (int): The sequence number for the command.
            data (Optional[bytes]): The data to be sent with the command.
        
        Returns:
            Response: The response from the device.
        """
        command = self.command_factory.create_command(tag, sequence, self.address, data)
        return self.send_command(command)

    def send_command(self, command: Command) -> Response:
        """
        Sends a command and returns the response.
        
        Args:
            command (Command): The command to be sent.
        
        Returns:
            Response: The response from the device.
        """
        logging.debug(f"Command: {command}")
        cmd: bytes = command.message
        rsp: bytes = self.write_cmd_rsp(cmd)
        response = osdp.parse_response(rsp)
        logging.debug(f"Response: {response}")
        return response


class CommandFactory:
    """
    Factory class to create OSDP commands based on CommandTags.
    """

    def __init__(self, use_crc: bool = False):
        """
        Initialize the CommandFactory.
        
        Args:
            use_crc (bool): Whether to use CRC for message integrity.
        """
        self.command_creators: Dict[CommandTags, Callable[[int, int, Optional[bytes], bool], Command]] = {}
        self.use_crc = use_crc
        self.register_commands()

    def register_command(self, tag: CommandTags):
        """
        Decorator to register a command creation function.
        
        Args:
            tag (CommandTags): The command tag to be registered.
        
        Returns:
            Callable: The decorator function.
        """
        def decorator(func: Callable[[int, int, Optional[bytes], bool], Command]):
            self.command_creators[tag] = func
            return func
        return decorator

    def create_command(self, tag: CommandTags, sequence: int, address: int, data: Optional[bytes] = None) -> Command:
        """
        Create a command based on the tag.
        
        Args:
            tag (CommandTags): The command tag indicating the type of command.
            sequence (int): The sequence number for the command.
            address (int): The address of the OSDP device.
            data (Optional[bytes]): The data to be sent with the command.
        
        Returns:
            Command: The created command.
        
        Raises:
            ValueError: If the command tag is not supported.
        """
        if tag in self.command_creators:
            return self.command_creators[tag](sequence, address, data, self.use_crc)
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
            return Command(CommandTags.ID, None, sequence, address, use_crc=use_crc)

        @self.register_command(CommandTags.CAP)
        def create_cap_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            return Command(CommandTags.CAP, None, sequence, address, use_crc=use_crc)

        @self.register_command(CommandTags.LSTAT)
        def create_lstat_command(sequence: int, address: int, data: Optional[bytes] = None, use_crc: bool = False) -> Command:
            return Command(CommandTags.LSTAT, None, sequence, address, use_crc=use_crc)

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
            return Command(CommandTags.KEYSET, data, sequence, address, use_crc=use_crc)
