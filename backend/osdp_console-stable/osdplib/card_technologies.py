import logging
CARD_TECHNOLOGIES = {
    "MIFARE_DESFIRE_EV1_CSN": ["048b3192696c80"],
    "MIFARE_DESFIRE_EV2_CSN": ["044f3b02fe1090"],
    "MIFARE_DESFIRE_EV3_CSN": ["045437f26c6e80"],
    "MIFARE_CLASSIC_CSN": ["060d1284"],
    "iCLASS_CSN": ["d5769415feff12e0"],
    "FSK_W32_5": ["deadbeef"],
    "ASK_W40_2": ["47868c00c8"],
    "W32_5": ["aabbccdd"],
    "Android_NFC": ["8c7daf32"],
    "iPhone_BLE": ["4ed3523d"]
}
    
def get_card_technology_names(card_technologies=CARD_TECHNOLOGIES):
    """
    Returns a list of card technology names that are keys in the CARD_TECHNOLOGIES dictionary.
    """
    return list(card_technologies.keys())

def get_card_technology_name_for_data(card_technologies=CARD_TECHNOLOGIES, data=None):
    """
    Returns the card technology name for the given data, or None if the data does not match any card technology.
    """
    for card_technology, card_technology_data in card_technologies.items():
        if data in card_technology_data:
            return card_technology
    return None