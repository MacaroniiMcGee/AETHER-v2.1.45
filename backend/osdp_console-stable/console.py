#!/usr/bin/python3
"""
console.py
Author: Taylor Schmidt, Michael Chaney

This is the entrypoint for communicating with a reader via OSDP.
"""
import logging
import sys
import argparse
from typing import List
import code
from config import load_config  # Import the load_config function
import random
import builtins

from osdplib import comms
from osdplib.osdpcontroller import OsdpController
from osdplib.osdp.constants import CommandTags

ARG_VERBOSE: List[str] = ["-v", "--verbose"]
ARG_IBEACON: List[str] = ["-i", "--ibeacon"]
ARG_CONF: List[str] = ["-c", "--config"]
ARG_FILE: List[str] = ["-f", "--file"]
ARG_POLL: List[str] = ["-p", "--poll"]
ARG_SERIAL: List[str] = ["-s", "--serial"]
ARG_BAUD: List[str] = ["-b", "--baud"]
ARG_SECURE: List[str] = ["-S", "--secure"]
ARG_FLUSH_LOG: List[str] = ["-F", "--flush-log"]
ARG_INLINE_LOG: List[str] = ["--inline-log"]
ARG_REPL: List[str] = ["-r", "--repl"]
ARG_COMMAND: List[str] = ["-C", "--command"]
ARG_LIST_COMMANDS: List[str] = ["-L", "--list-commands"]
ARG_PORT: List[str] = ["-P", "--port"]

COMMANDS = [
    "send_ibeacon_mfg",
    "request_conf",
    "transfer_file",
    "set_serial_number",
    "poll",
    "poll_forever",
    "id",
    "cap",
    "lstat",
]

def list_supported_commands():
    """Print the list of supported commands."""
    print("Supported commands:")
    for command in COMMANDS:
        print(f" - {command}")

def setup_logging(verbose: bool, inline_log: bool):
    """Set up the logging configuration."""
    log_level = logging.DEBUG if verbose else logging.INFO
    format_str = "%(asctime)s %(levelname)s %(message)s"

    if inline_log:
        logging.basicConfig(stream=sys.stdout, format=format_str, level=log_level)
        destination = "Terminal"
    else:
        filename = f"./logs/osdpcapture_{random.randint(0, 1000000)}.log"
        logging.basicConfig(filename=filename, format=format_str, level=log_level)
        destination = filename

    logging.info(f"Logging started with level {log_level} to {destination}")
    print(f"Logging started with level {log_level} to {destination}")

def execute_command(args, command_list):
    """Execute the specified command."""
    try:
        if args.ibeacon:
            command_list["send_ibeacon_mfg"]()
            sys.exit(0)

        if args.file:
            command_list["transfer_file"]()
            sys.exit(0)

        if args.serial:
            command_list["set_serial_number"]()
            sys.exit(0)

        if args.command:
            command_func = command_list.get(args.command)
            if command_func:
                command_result = command_func()
                logging.info(f"Command '{args.command}' result: {command_result}")
                print(f"Command '{args.command}' result: {command_result}")
            else:
                print(f"Command '{args.command}' not found.")
            if not args.poll:
                sys.exit(0)

        if args.poll:
            command_list["poll_forever"]()
            sys.exit(0)

        if args.repl:
            start_repl(command_list)
    except KeyboardInterrupt:
        print("user initiated exit")
        sys.exit(2)

def start_repl(command_list):
    """Start a REPL session."""
    print("==== Starting REPL session")
    variables = globals().copy()
    variables.update(locals())
    variables.update(command_list)
    shell = code.InteractiveConsole(variables)
    shell.interact()
    sys.exit(0)

def main():
    """Main function to parse arguments and execute commands."""
    parser = argparse.ArgumentParser(description="WaveLynx OSDP Console")
    parser.add_argument("-v", "--verbose", action="store_true", help="increase output verbosity")
    parser.add_argument("-i", "--ibeacon", action="store_true", help="configure iBeacon config")
    parser.add_argument(
        "-c", "--config", type=str, help="use configuration for the specified device"
    )
    parser.add_argument("-f", "--file", type=str, help="transfer file")
    parser.add_argument(
        "-p", "--poll", action="store_true", help="poll forever, check osdpcapture.log for events"
    )
    parser.add_argument("-s", "--serial", type=str, help="set serial number")
    parser.add_argument("-P", "--port", type=str, help="set serial port")
    parser.add_argument("-b", "--baud", type=int, help="set baud rate for serial communication")
    parser.add_argument(
        "-S", "--secure", action="store_true", help="initialize in secure OSDP mode"
    )
    parser.add_argument(
        "-F", "--flush-log", action="store_true", help="flush the log file before starting"
    )
    parser.add_argument("--inline-log", action="store_true", help="use terminal as the log file")
    parser.add_argument("-r", "--repl", action="store_true", help="start a REPL session")
    parser.add_argument(
        "-C", "--command", type=str, help="send a one-off command to the controller"
    )
    parser.add_argument(
        "-L", "--list-commands", action="store_true", help="list all supported commands"
    )

    args = parser.parse_args()

    if args.list_commands:
        list_supported_commands()
        sys.exit(0)

    if len(sys.argv) == 1:
        parser.print_help()
        sys.exit(0)

    # Flush existing log file only if not using inline logging
    if args.flush_log and not args.inline_log:
        with open("./osdpcapture.log", 'w', encoding='utf-8'):
            pass

    setup_logging(args.verbose, args.inline_log)

    if args.inline_log:
        builtins.print = lambda *args, **kwargs: None

    print("======== WaveLynx OSDP Console ========")

    # Determine the port and baud rate to use
    if args.config:
        config = load_config('config.json', args.config)
        for key, value in config.items():
            if not hasattr(args, key) or getattr(args, key) is None:
                setattr(args, key, value)
    
    port = args.port if args.port else comms.prompt_port()
    baud_rate = args.baud if args.baud else 9600

    if not port:
        print("No port selected, exiting.")
        sys.exit(1)

    # Initialize the OsdpController with or without secure mode
    controller = OsdpController(port, baud_rate=baud_rate, secure=args.secure)

    print(f"==== Device connected at: {port} with baud rate: {baud_rate}")

    logging.info("==== ARGS %s", sys.argv[1:])

    command_list = {
        "send_ibeacon_mfg": lambda: print("==== Configure iBeacon config")
                                or controller.send_ibeacon_mfg(),
        "request_conf": lambda: print("==== Request extended reader config")
                              or print(controller.request_conf()),
        "transfer_file": lambda: print("==== Transferring file")
                                or print(f"filepath {args.file}")
                                or controller.transfer_file(args.file),
        "set_serial_number": lambda: print("==== Setting serial number")
                                   or controller.dev.set_serial_number(args.serial),
        "poll": lambda: print(controller.send(CommandTags.POLL)),
        "poll_forever": lambda: print("==== Polling forever, check osdpcapture.log for events")
                               or controller.poll_forever(),
        "id": lambda:	controller.send(CommandTags.ID),
        "cap": lambda: controller.send(CommandTags.CAP),
        "lstat": lambda: controller.send(CommandTags.LSTAT),
        "mfg": lambda: controller.send(CommandTags.MFG, data=b'\x5c\x26\x23\x57\x49\x03\x00\x00'),
    }

    execute_command(args, command_list)

if __name__ == "__main__":
    main()
