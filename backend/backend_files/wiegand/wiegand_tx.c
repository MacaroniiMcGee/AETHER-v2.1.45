#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <gpiod.h>
#include <errno.h>

#define DEFAULT_PULSE_US 50
#define INTER_PULSE_MS 2
#define MAX_BITS 64

void usleep_precise(unsigned int usec) {
    struct timespec ts;
    ts.tv_sec = usec / 1000000;
    ts.tv_nsec = (usec % 1000000) * 1000;
    nanosleep(&ts, NULL);
}

int calculate_even_parity(const char* bits, int len) {
    int count = 0;
    for (int i = 0; i < len; i++) {
        if (bits[i] == '1') count++;
    }
    return (count % 2 == 0) ? 0 : 1;
}

int calculate_odd_parity(const char* bits, int len) {
    int count = 0;
    for (int i = 0; i < len; i++) {
        if (bits[i] == '1') count++;
    }
    return (count % 2 == 1) ? 0 : 1;
}

void int_to_binary(uint32_t value, char* output, int bits) {
    for (int i = bits - 1; i >= 0; i--) {
        output[bits - 1 - i] = ((value >> i) & 1) ? '1' : '0';
    }
    output[bits] = '\0';
}

// W26: [EP][8-bit facility][16-bit card][OP]
void encode_wiegand_26(uint32_t facility, uint32_t card, char* output) {
    char facility_bits[9], card_bits[17], data[25];
    int_to_binary(facility, facility_bits, 8);
    int_to_binary(card, card_bits, 16);
    strcpy(data, facility_bits);
    strcat(data, card_bits);
    int even_parity = calculate_even_parity(data, 12);
    int odd_parity = calculate_odd_parity(data + 12, 12);
    sprintf(output, "%d%s%d", even_parity, data, odd_parity);
}

// W30: [EP][10-bit facility][20-bit card][OP]
void encode_wiegand_30(uint32_t facility, uint32_t card, char* output) {
    char facility_bits[11], card_bits[21], data[31];
    int_to_binary(facility, facility_bits, 10);
    int_to_binary(card, card_bits, 20);
    strcpy(data, facility_bits);
    strcat(data, card_bits);
    int even_parity = calculate_even_parity(data, 15);
    int odd_parity = calculate_odd_parity(data + 15, 15);
    sprintf(output, "%d%s%d", even_parity, data, odd_parity);
}

// W32: [32-bit card] (no parity, no facility)
void encode_wiegand_32(uint32_t card, char* output) {
    int_to_binary(card, output, 32);
}

// W34: [EP][16-bit facility][16-bit card][OP]
void encode_wiegand_34(uint32_t facility, uint32_t card, char* output) {
    char facility_bits[17], card_bits[17], data[33];
    int_to_binary(facility, facility_bits, 16);
    int_to_binary(card, card_bits, 16);
    strcpy(data, facility_bits);
    strcat(data, card_bits);
    int even_parity = calculate_even_parity(data, 16);
    int odd_parity = calculate_odd_parity(data + 16, 16);
    sprintf(output, "%d%s%d", even_parity, data, odd_parity);
}

// W35: [EP][01][12-bit facility][20-bit card] (whole even parity)
void encode_wiegand_35(uint32_t facility, uint32_t card, char* output) {
    char facility_bits[13], card_bits[21], data[35];
    int_to_binary(facility, facility_bits, 12);
    int_to_binary(card, card_bits, 20);
    sprintf(data, "01%s%s", facility_bits, card_bits);
    int even_parity = calculate_even_parity(data, 34);
    sprintf(output, "%d%s", even_parity, data);
}

// W37: [EP][16-bit facility][19-bit card][OP]
void encode_wiegand_37(uint32_t facility, uint32_t card, char* output) {
    char facility_bits[17], card_bits[20], data[36];
    int_to_binary(facility, facility_bits, 16);
    int_to_binary(card, card_bits, 19);
    strcpy(data, facility_bits);
    strcat(data, card_bits);
    int even_parity = calculate_even_parity(data, 18);
    int odd_parity = calculate_odd_parity(data + 18, 17);
    sprintf(output, "%d%s%d", even_parity, data, odd_parity);
}

// W38: [EP][16-bit facility][20-bit card][OP]
void encode_wiegand_38(uint32_t facility, uint32_t card, char* output) {
    char facility_bits[17], card_bits[21], data[37];
    int_to_binary(facility, facility_bits, 16);
    int_to_binary(card, card_bits, 20);
    strcpy(data, facility_bits);
    strcat(data, card_bits);
    int even_parity = calculate_even_parity(data, 18);
    int odd_parity = calculate_odd_parity(data + 18, 18);
    sprintf(output, "%d%s%d", even_parity, data, odd_parity);
}

// W40: [EP][16-bit facility][22-bit card][OP]
void encode_wiegand_40(uint32_t facility, uint32_t card, char* output) {
    char facility_bits[17], card_bits[23], data[39];
    int_to_binary(facility, facility_bits, 16);
    int_to_binary(card, card_bits, 22);
    strcpy(data, facility_bits);
    strcat(data, card_bits);
    int even_parity = calculate_even_parity(data, 19);
    int odd_parity = calculate_odd_parity(data + 19, 19);
    sprintf(output, "%d%s%d", even_parity, data, odd_parity);
}

// W46: [EP][20-bit facility][24-bit card][OP]
void encode_wiegand_46(uint32_t facility, uint32_t card, char* output) {
    char facility_bits[21], card_bits[25], data[45];
    int_to_binary(facility, facility_bits, 20);
    int_to_binary(card, card_bits, 24);
    strcpy(data, facility_bits);
    strcat(data, card_bits);
    int even_parity = calculate_even_parity(data, 22);
    int odd_parity = calculate_odd_parity(data + 22, 22);
    sprintf(output, "%d%s%d", even_parity, data, odd_parity);
}

// W48: [EP][22-bit facility][24-bit card][OP]
void encode_wiegand_48(uint32_t facility, uint32_t card, char* output) {
    char facility_bits[23], card_bits[25], data[47];
    int_to_binary(facility, facility_bits, 22);
    int_to_binary(card, card_bits, 24);
    strcpy(data, facility_bits);
    strcat(data, card_bits);
    int even_parity = calculate_even_parity(data, 23);
    int odd_parity = calculate_odd_parity(data + 23, 23);
    sprintf(output, "%d%s%d", even_parity, data, odd_parity);
}

// W56: [EP][24-bit facility][30-bit card][OP]
void encode_wiegand_56(uint32_t facility, uint64_t card, char* output) {
    char facility_bits[25], card_bits[31], data[55];
    int_to_binary(facility, facility_bits, 24);
    // For 30-bit card, we need special handling
    for (int i = 29; i >= 0; i--) {
        card_bits[29 - i] = ((card >> i) & 1) ? '1' : '0';
    }
    card_bits[30] = '\0';
    strcpy(data, facility_bits);
    strcat(data, card_bits);
    int even_parity = calculate_even_parity(data, 27);
    int odd_parity = calculate_odd_parity(data + 27, 27);
    sprintf(output, "%d%s%d", even_parity, data, odd_parity);
}

// W64: [EP][28-bit facility][34-bit card][OP]
void encode_wiegand_64(uint64_t facility, uint64_t card, char* output) {
    char facility_bits[29], card_bits[35], data[63];
    // For 28-bit facility
    for (int i = 27; i >= 0; i--) {
        facility_bits[27 - i] = ((facility >> i) & 1) ? '1' : '0';
    }
    facility_bits[28] = '\0';
    // For 34-bit card
    for (int i = 33; i >= 0; i--) {
        card_bits[33 - i] = ((card >> i) & 1) ? '1' : '0';
    }
    card_bits[34] = '\0';
    strcpy(data, facility_bits);
    strcat(data, card_bits);
    int even_parity = calculate_even_parity(data, 31);
    int odd_parity = calculate_odd_parity(data + 31, 31);
    sprintf(output, "%d%s%d", even_parity, data, odd_parity);
}

struct gpiod_chip* open_gpio_chip(void) {
    const char* chips[] = {"/dev/gpiochip0", "/dev/gpiochip4", "gpiochip0", "gpiochip4", NULL};
    struct gpiod_chip *chip = NULL;
    
    for (int i = 0; chips[i] != NULL; i++) {
        printf("Trying %s... ", chips[i]);
        chip = gpiod_chip_open(chips[i]);
        if (chip) {
            printf("SUCCESS\n");
            return chip;
        }
        printf("failed\n");
    }
    
    fprintf(stderr, "\nERROR: No GPIO chip found\n");
    return NULL;
}

int send_wiegand_pulses(unsigned int d0_pin, unsigned int d1_pin, const char* bits, int pulse_us) {
    struct gpiod_chip *chip;
    struct gpiod_line_request *request = NULL;
    struct gpiod_request_config *req_cfg;
    struct gpiod_line_config *line_cfg;
    struct gpiod_line_settings *settings;
    int ret = 0;
    int bit_count = strlen(bits);
    
    chip = open_gpio_chip();
    if (!chip) return -1;
    
    settings = gpiod_line_settings_new();
    if (!settings) {
        gpiod_chip_close(chip);
        return -1;
    }
    
    // Set direction as output
    gpiod_line_settings_set_direction(settings, GPIOD_LINE_DIRECTION_OUTPUT);
    
    // Set initial output value to HIGH (active for Wiegand idle state)
    gpiod_line_settings_set_output_value(settings, GPIOD_LINE_VALUE_ACTIVE);
    
    // *** FIX FOR GPIO 5 & 6 ***
    // Disable internal pull-up/pull-down resistors - let external circuit control
    // This is CRITICAL for GPIO 5 and 6 which have different default bias than GPIO 12/13
    gpiod_line_settings_set_bias(settings, GPIOD_LINE_BIAS_DISABLED);
    
    // Set drive mode to push-pull for stronger signal
    gpiod_line_settings_set_drive(settings, GPIOD_LINE_DRIVE_PUSH_PULL);
    
    line_cfg = gpiod_line_config_new();
    if (!line_cfg) {
        gpiod_line_settings_free(settings);
        gpiod_chip_close(chip);
        return -1;
    }
    
    gpiod_line_config_add_line_settings(line_cfg, &d0_pin, 1, settings);
    gpiod_line_config_add_line_settings(line_cfg, &d1_pin, 1, settings);
    
    req_cfg = gpiod_request_config_new();
    if (!req_cfg) {
        gpiod_line_config_free(line_cfg);
        gpiod_line_settings_free(settings);
        gpiod_chip_close(chip);
        return -1;
    }
    
    gpiod_request_config_set_consumer(req_cfg, "wiegand_tx");
    
    request = gpiod_chip_request_lines(chip, req_cfg, line_cfg);
    if (!request) {
        fprintf(stderr, "Failed to request GPIO D0=%u D1=%u: %s\n", d0_pin, d1_pin, strerror(errno));
        fprintf(stderr, "\n=== TROUBLESHOOTING FOR GPIO %u/%u ===\n", d0_pin, d1_pin);
        fprintf(stderr, "1. Check if pins are in use: gpioinfo gpiochip0 | grep -E 'line\\s+(%u|%u)'\n", d0_pin, d1_pin);
        fprintf(stderr, "2. Check for HAT overlays in /boot/config.txt\n");
        fprintf(stderr, "3. Try releasing the pins: sudo gpioset gpiochip0 %u=1 %u=1\n", d0_pin, d1_pin);
        fprintf(stderr, "4. Check if I2C or other interfaces are using these pins\n");
        gpiod_request_config_free(req_cfg);
        gpiod_line_config_free(line_cfg);
        gpiod_line_settings_free(settings);
        gpiod_chip_close(chip);
        return -1;
    }
    
    printf("GPIO D0=%u D1=%u acquired (bias disabled, push-pull drive)\n", d0_pin, d1_pin);
    printf("Sending %d bits with %dus pulses...\n", bit_count, pulse_us);
    
    // Pre-condition: ensure lines are HIGH before transmission
    gpiod_line_request_set_value(request, d0_pin, GPIOD_LINE_VALUE_ACTIVE);
    gpiod_line_request_set_value(request, d1_pin, GPIOD_LINE_VALUE_ACTIVE);
    
    // Allow lines to stabilize (especially important for GPIO 5/6)
    usleep_precise(2000);  // Increased from 1000us to 2000us for stability
    
    for (int i = 0; i < bit_count; i++) {
        unsigned int pin = (bits[i] == '0') ? d0_pin : d1_pin;
        
        // Pull line LOW (INACTIVE) for pulse
        ret = gpiod_line_request_set_value(request, pin, GPIOD_LINE_VALUE_INACTIVE);
        if (ret < 0) {
            fprintf(stderr, "Failed to set GPIO %u LOW at bit %d: %s\n", pin, i, strerror(errno));
            break;
        }
        
        // Hold LOW for pulse duration
        usleep_precise(pulse_us);
        
        // Return line HIGH (ACTIVE)
        ret = gpiod_line_request_set_value(request, pin, GPIOD_LINE_VALUE_ACTIVE);
        if (ret < 0) {
            fprintf(stderr, "Failed to set GPIO %u HIGH at bit %d: %s\n", pin, i, strerror(errno));
            break;
        }
        
        // Inter-pulse gap
        if (i < bit_count - 1) {
            usleep_precise(INTER_PULSE_MS * 1000);
        }
        
        // Progress output
        if ((i + 1) % 8 == 0 || i == bit_count - 1) {
            printf("  %d/%d bits\n", i + 1, bit_count);
        }
    }
    
    // Ensure lines are HIGH after transmission (proper idle state)
    gpiod_line_request_set_value(request, d0_pin, GPIOD_LINE_VALUE_ACTIVE);
    gpiod_line_request_set_value(request, d1_pin, GPIOD_LINE_VALUE_ACTIVE);
    
    if (ret == 0) {
        printf("\n✓ Transmission complete!\n");
    } else {
        printf("\n✗ Transmission failed!\n");
    }
    
    gpiod_line_request_release(request);
    gpiod_request_config_free(req_cfg);
    gpiod_line_config_free(line_cfg);
    gpiod_line_settings_free(settings);
    gpiod_chip_close(chip);
    
    return ret;
}

int main(int argc, char *argv[]) {
    if (argc < 6) {
        fprintf(stderr, "Usage: %s <d0> <d1> <facility> <card> <bits> [pulse_us]\n", argv[0]);
        fprintf(stderr, "Example: sudo %s 5 6 123 45678 26 50\n", argv[0]);
        fprintf(stderr, "         sudo %s 12 13 123 45678 26 50\n", argv[0]);
        fprintf(stderr, "Supported formats: 26, 30, 32, 34, 35, 37, 38, 40, 46, 48, 56, 64 bits\n");
        return 1;
    }
    
    unsigned int d0 = atoi(argv[1]);
    unsigned int d1 = atoi(argv[2]);
    uint64_t fac = strtoull(argv[3], NULL, 10);
    uint64_t crd = strtoull(argv[4], NULL, 10);
    int bits = atoi(argv[5]);
    int pus = (argc == 7) ? atoi(argv[6]) : DEFAULT_PULSE_US;
    
    if (d0 > 27 || d1 > 27 || d0 == d1) {
        fprintf(stderr, "Error: Invalid GPIO pins (must be 0-27 and different)\n");
        return 1;
    }
    
    printf("=== Wiegand TX (GPIO %u/%u) ===\n", d0, d1);
    
    char enc[MAX_BITS + 1];
    
    switch (bits) {
        case 26:
            if (fac > 255 || crd > 65535) {
                fprintf(stderr, "Error: W26 limits: facility 0-255, card 0-65535\n");
                return 1;
            }
            printf("Wiegand-26: Facility=%lu Card=%lu\n", fac, crd);
            encode_wiegand_26(fac, crd, enc);
            break;
            
        case 30:
            if (fac > 1023 || crd > 1048575) {
                fprintf(stderr, "Error: W30 limits: facility 0-1023, card 0-1048575\n");
                return 1;
            }
            printf("Wiegand-30: Facility=%lu Card=%lu\n", fac, crd);
            encode_wiegand_30(fac, crd, enc);
            break;
            
        case 32:
            if (crd > 4294967295ULL) {
                fprintf(stderr, "Error: W32 limits: card 0-4294967295\n");
                return 1;
            }
            printf("Wiegand-32: Card=%lu (no facility)\n", crd);
            encode_wiegand_32(crd, enc);
            break;
            
        case 34:
            if (fac > 65535 || crd > 65535) {
                fprintf(stderr, "Error: W34 limits: facility 0-65535, card 0-65535\n");
                return 1;
            }
            printf("Wiegand-34: Facility=%lu Card=%lu\n", fac, crd);
            encode_wiegand_34(fac, crd, enc);
            break;
            
        case 35:
            if (fac > 4095 || crd > 1048575) {
                fprintf(stderr, "Error: W35 limits: facility 0-4095, card 0-1048575\n");
                return 1;
            }
            printf("Wiegand-35 (HID Corporate 1000): Facility=%lu Card=%lu\n", fac, crd);
            encode_wiegand_35(fac, crd, enc);
            break;
            
        case 37:
            if (fac > 65535 || crd > 524287) {
                fprintf(stderr, "Error: W37 limits: facility 0-65535, card 0-524287\n");
                return 1;
            }
            printf("Wiegand-37: Facility=%lu Card=%lu\n", fac, crd);
            encode_wiegand_37(fac, crd, enc);
            break;
            
        case 38:
            if (fac > 65535 || crd > 1048575) {
                fprintf(stderr, "Error: W38 limits: facility 0-65535, card 0-1048575\n");
                return 1;
            }
            printf("Wiegand-38: Facility=%lu Card=%lu\n", fac, crd);
            encode_wiegand_38(fac, crd, enc);
            break;
            
        case 40:
            if (fac > 65535 || crd > 4194303) {
                fprintf(stderr, "Error: W40 limits: facility 0-65535, card 0-4194303\n");
                return 1;
            }
            printf("Wiegand-40 (STID): Facility=%lu Card=%lu\n", fac, crd);
            encode_wiegand_40(fac, crd, enc);
            break;
            
        case 46:
            if (fac > 1048575 || crd > 16777215) {
                fprintf(stderr, "Error: W46 limits: facility 0-1048575, card 0-16777215\n");
                return 1;
            }
            printf("Wiegand-46: Facility=%lu Card=%lu\n", fac, crd);
            encode_wiegand_46(fac, crd, enc);
            break;
            
        case 48:
            if (fac > 4194303 || crd > 16777215) {
                fprintf(stderr, "Error: W48 limits: facility 0-4194303, card 0-16777215\n");
                return 1;
            }
            printf("Wiegand-48 (HID Corporate 1000): Facility=%lu Card=%lu\n", fac, crd);
            encode_wiegand_48(fac, crd, enc);
            break;
            
        case 56:
            if (fac > 16777215 || crd > 1073741823) {
                fprintf(stderr, "Error: W56 limits: facility 0-16777215, card 0-1073741823\n");
                return 1;
            }
            printf("Wiegand-56: Facility=%lu Card=%lu\n", fac, crd);
            encode_wiegand_56(fac, crd, enc);
            break;
            
        case 64:
            if (fac > 268435455 || crd > 17179869183ULL) {
                fprintf(stderr, "Error: W64 limits: facility 0-268435455, card 0-17179869183\n");
                return 1;
            }
            printf("Wiegand-64 (SEOS): Facility=%lu Card=%lu\n", fac, crd);
            encode_wiegand_64(fac, crd, enc);
            break;
            
        default:
            fprintf(stderr, "Error: Unsupported format. Supported: 26, 30, 32, 34, 35, 37, 38, 40, 46, 48, 56, 64 bits\n");
            return 1;
    }
    
    printf("Binary: %s (%d bits)\n\n", enc, bits);
    
    return send_wiegand_pulses(d0, d1, enc, pus) < 0 ? 1 : 0;
}
