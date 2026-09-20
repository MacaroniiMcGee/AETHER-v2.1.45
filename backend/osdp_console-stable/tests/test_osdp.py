import pytest
import logging
from osdplib.osdp.constants import CommandTags, ResponseTags, SecurityConstants, TamperStatus, PowerStatus, NAKCodes, SCBK_D_KEY, SCBK_KEY_2
from osdplib.osdpcontroller import OsdpController
from osdplib.card_technologies import get_card_technology_names

# Configure logging to output to the console
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Combined and parameterized test for osdp_init and secure_osdp_init
@pytest.mark.parametrize('device_config', ['lock', 'reader'], indirect=True)
@pytest.mark.parametrize('mode', ['secure', 'plaintext'], indirect=True)
@pytest.mark.parametrize('checksum_type', ['crc', 'cksum'], indirect=True)
def test_osdp_init(controller, device_config, mode, checksum_type):
    device_type, config = device_config
    assert controller is not None, logging.error("Controller is None")
    logging.info(f"Testing {mode} osdp {device_type} initialization with {checksum_type}")

    if mode == 'secure':
        assert controller.secure_channel_initialized == True, logging.error("Secure channel not initialized")
    else:
        response = controller.send(CommandTags.POLL)
        assert response is not None, logging.error("Response is None")
        assert response.code == ResponseTags.ACK, logging.error(f"Expected ACK but got {response.code.name} ({hex(response.code.value)})")

# Test for repeated secure initialization
@pytest.mark.parametrize('device_config', ['lock', 'reader'], indirect=True)
@pytest.mark.parametrize('checksum_type', ['crc', 'cksum'], indirect=True)
def test_repeated_secure_init(secure_controller, device_config, checksum_type):
    device_type, config = device_config
    assert secure_controller is not None, logging.error("Secure controller is None")
    REPEAT_COUNT = 5
    logging.info(f"Testing {REPEAT_COUNT} secure osdp {device_type} initializations with {checksum_type}")

    for i in range(REPEAT_COUNT):
        secure_controller.send(CommandTags.POLL)
        logging.info(f"Testing secure osdp {device_type} initialization {i+1}/{REPEAT_COUNT}")
        secure_controller = OsdpController(config['port'], config['baud_rate'], secure=True, scbk=SCBK_D_KEY, use_crc=(checksum_type == 'crc'))
        assert secure_controller.secure_channel_initialized == True, logging.error("Secure channel not initialized")

# Test for plaintext and secure polling
@pytest.mark.parametrize('device_config', ['lock', 'reader'], indirect=True)
@pytest.mark.parametrize('mode', ['secure', 'plaintext'], indirect=True)
@pytest.mark.parametrize('checksum_type', ['crc', 'cksum'], indirect=True)
def test_poll(controller, device_config, mode, checksum_type):
    device_type, config = device_config
    assert controller is not None, logging.error("Controller is None")
    logging.info(f"Testing {mode} osdp {device_type} polling with {checksum_type}")

    response = controller.send(CommandTags.POLL)
    assert response is not None, logging.error("Response is None")
    assert response.code == ResponseTags.ACK or response.code == ResponseTags.RAW_CARD, logging.error(f"Expected ACK or RAW_CARD but got {response.code.name} ({hex(response.code.value)})")

@pytest.mark.parametrize('device_config', ['lock', 'reader'], indirect=True)
@pytest.mark.parametrize('mode', ['secure', 'plaintext'], indirect=True)
@pytest.mark.parametrize('checksum_type', ['crc', 'cksum'], indirect=True)
def test_id(controller, device_config, mode, checksum_type):
    device_type, config = device_config
    assert controller is not None, logging.error("Controller is None")
    logging.info(f"Testing {mode} osdp {device_type} id command with {checksum_type}")

    response = controller.send(CommandTags.ID)
    assert response is not None, logging.error("Response is None")
    assert response.code == ResponseTags.PDID, logging.error(f"Expected PDID but got {response.code.name} ({hex(response.code.value)})")
    if device_type == 'reader':
        # valid fw versions include 3.x.x and 4.x.x
        fw_major = int(response.firmware_version[0])
        assert fw_major in [3, 4], logging.error(f"Invalid firmware major version: {fw_major}")
        # wavelynx vendor code is 5c2623
        assert response.vendor_code == 0x5c2623, logging.error(f"Invalid vendor code: {hex(response.vendor_code)}")
    if device_type == 'lock':
        # let's stick expected values in a dictionary to keep it clean
        expected = {
            'vendor_code': 0x5c2623,
            'model_number': 0x10,
            'version': 0x00,
            'serial_number': 0xaabbccdd,
            'firmware_version': '0.9.2'
        }
        assert response.vendor_code == expected['vendor_code'], logging.error(f"Expected {hex(expected['vendor_code'])} but got {hex(response.vendor_code)}")
        assert response.model_number == expected['model_number'], logging.error(f"Expected {hex(expected['model_number'])} but got {hex(response.model_number)}")
        assert response.version == expected['version'], logging.error(f"Expected {expected['version']} but got {response.version}")
        assert response.serial_number == expected['serial_number'], logging.error(f"Expected {hex(expected['serial_number'])} but got {hex(response.serial_number)}")
        assert response.firmware_version == expected['firmware_version'], logging.error(f"Expected {expected['firmware_version']} but got {response.firmware_version}")

# Test for plaintext and secure cap command
@pytest.mark.parametrize('device_config', ['lock', 'reader'], indirect=True)
@pytest.mark.parametrize('mode', ['secure', 'plaintext'], indirect=True)
@pytest.mark.parametrize('checksum_type', ['crc', 'cksum'], indirect=True)
def test_cap(controller, device_config, mode, checksum_type):
    device_type, config = device_config
    assert controller is not None, logging.error("Controller is None")
    logging.info(f"Testing {mode} osdp {device_type} cap command with {checksum_type}")

    response = controller.send(CommandTags.CAP)
    assert response is not None, logging.error("Response is None")
    assert response.code == ResponseTags.PDCAP, logging.error(f"Expected PDCAP but got {response.code.name} ({hex(response.code.value)})")

def test_led(controller, device_config):
    device_type, config = device_config
    assert controller is not None, logging.error("Controller is None")
    logging.info(f"Testing osdp {device_type} led command")

    response = controller.send(CommandTags.LED)
    assert response is not None, logging.error("Response is None")
    assert response.code == ResponseTags.ACK, logging.error(f"Expected ACK but got {response.code.name} ({hex(response.code.value)})")

# Test for LSTAT command
@pytest.mark.parametrize('device_config', ['lock', 'reader'], indirect=True)
@pytest.mark.parametrize('mode', ['secure', 'plaintext'], indirect=True)
@pytest.mark.parametrize('checksum_type', ['crc', 'cksum'], indirect=True)
def test_lstat(controller, device_config, mode, checksum_type):
    device_type, config = device_config
    assert controller is not None, logging.error("Controller is None")
    logging.info(f"Testing {mode} osdp {device_type} lstat command with {checksum_type}")

    response = controller.send(CommandTags.LSTAT)
    assert response is not None, logging.error("Response is None")
    assert response.code == ResponseTags.LSTATR, logging.error(f"Expected LSTATR but got {response.code.name} ({hex(response.code.value)})")
    assert response.tamper_status == TamperStatus.NORMAL, logging.error(f"Expected tamper status NORMAL but got {response.tamper_status}")
    assert response.power_status == TamperStatus.NORMAL, logging.error(f"Expected power status NORMAL but got {response.power_status}")

# Test for Keyset command
@pytest.mark.parametrize('device_config', ['lock', 'reader'], indirect=True)
@pytest.mark.parametrize('checksum_type', ['crc', 'cksum'], indirect=True)
def test_keyset(device_config, checksum_type):
    device_type, config = device_config
    logging.info(f"Testing osdp {device_type} keyset command with {checksum_type}")

    controller = OsdpController(config['port'], config['baud_rate'], use_crc=(checksum_type == 'crc'))
    assert controller is not None, logging.error("Controller is None")
    
    # test with plaintext channel, should return NAK on reader with encryption required
    # lock module can be considered inherently secure, so it can accept the keyset command in plaintext mode
    if device_type == 'reader':
        response = controller.send(CommandTags.KEYSET, SCBK_KEY_2)
        assert response.code == ResponseTags.NAK, logging.error(f"Expected NAK but got {response.code.name} ({hex(response.code.value)})")
        assert response.error_code == NAKCodes.ENCRYPTION_REQUIRED, logging.error(f"Expected encryption required but got {response.error_code}")

    # if device_type == 'lock':
    #     response = controller.send(CommandTags.KEYSET, SCBK_KEY_2)
    #     assert response is not None, logging.error("Response is None")
    #     logging.info(f"Keyset response: {response}")
    #     # Expect ACK because the Lock Module can be considered "inherently secure". This raises questions about setup mode.
    #     assert response.code == ResponseTags.ACK, logging.error(f"Expected ACK but got {response.code.name} ({hex(response.code.value)})")

    # now test with secure channel
    secure_controller = OsdpController(config['port'], config['baud_rate'], secure=True, scbk=SCBK_D_KEY, use_crc=(checksum_type == 'crc'))
    assert secure_controller.secure_channel_initialized == True, logging.error("Secure channel not initialized")
    response = secure_controller.send(CommandTags.KEYSET, security_type=SecurityConstants.SCS_17, data=SCBK_KEY_2)
    assert response.code == ResponseTags.ACK, logging.error(f"Expected ACK but got {response.code.name} ({hex(response.code.value)})")

    # now try to setup secure channel with the new key
    secure_controller = OsdpController(config['port'], config['baud_rate'], secure=True, scbk=SCBK_KEY_2, use_crc=(checksum_type == 'crc'))

    assert secure_controller.secure_channel_initialized == True, logging.error("Secure channel not initialized")
    response = secure_controller.send(CommandTags.POLL)
    assert response.code == ResponseTags.ACK, logging.error(f"Expected ACK but got {response.code.name} ({hex(response.code.value)})")

    # Reset to SCBK_D_KEY
    secure_controller.send(CommandTags.KEYSET, SCBK_D_KEY)

@pytest.mark.parametrize('device_config', ['lock', 'reader'], indirect=True)
@pytest.mark.parametrize('checksum_type', ['crc', 'cksum'], indirect=True)
@pytest.mark.manual
def test_keyset_with_reboot(device_config, checksum_type):
    device_type, config = device_config
    logging.info(f"Testing osdp {device_type} keyset command with {checksum_type} and reboot")
    
    secure_start = True if device_type == 'reader' else False
    controller = OsdpController(config['port'], config['baud_rate'],secure=secure_start, use_crc=(checksum_type == 'crc'))
    assert controller is not None, logging.error("Controller is None")

    # issue a KEYSET command in plaintext mode to set the key to SCBK_KEY_2
    response = controller.send(CommandTags.KEYSET, SCBK_KEY_2)
    assert response is not None, logging.error("Response is None")
    assert response.code == ResponseTags.ACK, logging.error(f"Expected ACK but got {response.code.name} ({hex(response.code.value)})")

    # Wait for the user to confirm the device has rebooted
    input("Please reboot the device now and press Enter to continue...")

    # After reboot, reinitialize the controller with SCBK_KEY_2
    secure_controller = OsdpController(config['port'], config['baud_rate'], secure=True, scbk=SCBK_KEY_2, use_crc=(checksum_type == 'crc'))
    assert secure_controller.secure_channel_initialized == True, logging.error("Secure channel not initialized")
    response = secure_controller.send(CommandTags.POLL)
    assert response.code == ResponseTags.ACK, logging.error(f"Expected ACK but got {response.code.name} ({hex(response.code.value)})")

@pytest.mark.parametrize('device_config', ['lock', 'reader'], indirect=True)
@pytest.mark.parametrize('mode', ['secure', 'plaintext'], indirect=True)
@pytest.mark.manual
def test_card_read(controller, device_config, mode):
    device_type, config = device_config
    assert controller is not None, logging.error("Controller is None")
    logging.info(f"Testing {mode} osdp {device_type} card read")

    # Load card technologies from file
    card_technologies = get_card_technology_names()
    assert card_technologies is not None, logging.error("Card technologies is None")

    skipped_technologies = []

    # For each card technology, ask the user to present a card
    for card_technology in card_technologies:
        while True:
            input(f"Please present a card of type {card_technology} and press Enter to continue...")
            response = controller.send(CommandTags.POLL)
            assert response is not None, logging.error("Response is None")
            
            if response.code == ResponseTags.ACK:
                logging.warning(f"Received ACK for {card_technology}. Marking as skipped.")
                skipped_technologies.append(card_technology)
                break  # Skip to the next technology

            if response.code == ResponseTags.RAW_CARD:
                if response.card_technology == card_technology:
                    logging.info(f"Successfully read card of type {card_technology}")
                    break  # Move on to the next technology
                else:
                    retry = input(f"Expected card technology {card_technology}, but got {response.card_technology}. Do you want to try again? (y/n): ").strip().lower()
                    if retry != 'y':
                        logging.warning(f"Skipping {card_technology} after mismatched card type.")
                        skipped_technologies.append(card_technology)
                        break  # Skip to the next technology

    if skipped_technologies:
        skipped_list = ', '.join(skipped_technologies)
        pytest.fail(f"Skipped card technologies: {skipped_list}")

@pytest.mark.parametrize('device_config', ['reader'], indirect=True)
def test_amag_tamper(controller):
    # we'll issue an ID, CAP, and LED command, then go into a poll loop and fail if we get back a tamper status
    response = controller.send(CommandTags.ID)
    assert response is not None, logging.error("Response is None")
    assert response.code == ResponseTags.PDID, logging.error(f"Expected PDID but got {response.code.name} ({hex(response.code.value)})")

    response = controller.send(CommandTags.CAP)
    assert response is not None, logging.error("Response is None")
    assert response.code == ResponseTags.PDCAP, logging.error(f"Expected PDCAP but got {response.code.name} ({hex(response.code.value)})")

    response = controller.send(CommandTags.LED)
    assert response is not None, logging.error("Response is None")
    assert response.code == ResponseTags.ACK, logging.error(f"Expected ACK but got {response.code.name} ({hex(response.code.value)})")

    # now go into a poll loop
    controller.poll_forever()