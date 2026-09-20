import pytest
from config import load_config  # Import the load_config function
from osdplib.osdpcontroller import OsdpController
from osdplib.osdp.constants import SCBK_D_KEY

# Add the custom option to control manual tests
def pytest_addoption(parser):
    parser.addoption(
        "--runmanual", action="store_true", default=False, help="Run tests marked as manual"
    )

# Register the manual marker
def pytest_configure(config):
    config.addinivalue_line("markers", "manual: mark test as requiring manual intervention")

# Skip manual tests unless --runmanual is specified
def pytest_collection_modifyitems(config, items):
    if not config.getoption("--runmanual"):
        skip_manual = pytest.mark.skip(reason="Manual tests skipped. Use --runmanual to run.")
        for item in items:
            if "manual" in item.keywords:
                item.add_marker(skip_manual)

@pytest.fixture
def config():
    return load_config('config.json', 'devices')

@pytest.fixture(params=['lock', 'reader', 'controller'])
def device_config(request, config):
    device_type = request.param
    return device_type, config[device_type]

@pytest.fixture(params=['secure', 'plaintext'])
def mode(request):
    return request.param

@pytest.fixture(params=['crc', 'cksum'])
def checksum_type(request):
    return request.param

@pytest.fixture
def controller(device_config, mode, checksum_type):
    device_type, config = device_config
    use_crc = True if checksum_type == 'crc' else False
    secure = True if mode == 'secure' else False
    scbk = None if not secure else config.get('scbk')
    return OsdpController(config['port'], config['baud_rate'], use_crc=use_crc, secure=secure, scbk=SCBK_D_KEY)

@pytest.fixture
def secure_controller(device_config, checksum_type):
    device_type, config = device_config
    use_crc = True if checksum_type == 'crc' else False
    return OsdpController(config['port'], config['baud_rate'], use_crc=use_crc, secure=True, scbk=SCBK_D_KEY)
