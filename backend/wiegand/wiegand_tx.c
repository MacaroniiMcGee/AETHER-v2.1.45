#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <gpiod.h>
#include <errno.h>

#define DEFAULT_PULSE_US 50
#define INTER_PULSE_US 1000
#define MAX_BITS 128

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

void int_to_binary(uint64_t value, char* output, int bits) {
    for (int i = bits - 1; i >= 0; i--) {
        output[bits - 1 - i] = ((value >> i) & 1) ? '1' : '0';
    }
    output[bits] = '\0';
}

// Encoding functions
void encode_w26(uint32_t fac, uint32_t card, char* out) {
    char data[25];
    int_to_binary(fac, data, 8);
    int_to_binary(card, data + 8, 16);
    int ep = calculate_even_parity(data, 12);
    int op = calculate_odd_parity(data + 12, 12);
    sprintf(out, "%d%s%d", ep, data, op);
}

void encode_w34(uint32_t fac, uint32_t card, char* out) {
    char data[33];
    int_to_binary(fac, data, 16);
    int_to_binary(card, data + 16, 16);
    int ep = calculate_even_parity(data, 16);
    int op = calculate_odd_parity(data + 16, 16);
    sprintf(out, "%d%s%d", ep, data, op);
}

void encode_w37(uint32_t fac, uint32_t card, char* out) {
    char data[36];
    int_to_binary(fac, data, 16);
    int_to_binary(card, data + 16, 19);
    int ep = calculate_even_parity(data, 18);
    int op = calculate_odd_parity(data + 18, 17);
    sprintf(out, "%d%s%d", ep, data, op);
}

int send_wiegand(unsigned int d0, unsigned int d1, const char* bits, int pulse_us) {
    struct gpiod_chip *chip;
    struct gpiod_line_request *request = NULL;
    struct gpiod_request_config *req_cfg;
    struct gpiod_line_config *line_cfg;
    struct gpiod_line_settings *settings;
    int ret = 0;
    int bit_count = strlen(bits);
    
    // Open GPIO chip
    chip = gpiod_chip_open("/dev/gpiochip0");
    if (!chip) {
        fprintf(stderr, "Failed to open gpiochip0\n");
        return -1;
    }
    
    settings = gpiod_line_settings_new();
    gpiod_line_settings_set_direction(settings, GPIOD_LINE_DIRECTION_OUTPUT);
    gpiod_line_settings_set_output_value(settings, GPIOD_LINE_VALUE_ACTIVE);
    gpiod_line_settings_set_drive(settings, GPIOD_LINE_DRIVE_PUSH_PULL);
    gpiod_line_settings_set_bias(settings, GPIOD_LINE_BIAS_DISABLED);
    
    line_cfg = gpiod_line_config_new();
    gpiod_line_config_add_line_settings(line_cfg, &d0, 1, settings);
    gpiod_line_config_add_line_settings(line_cfg, &d1, 1, settings);
    
    req_cfg = gpiod_request_config_new();
    gpiod_request_config_set_consumer(req_cfg, "wiegand_tx");
    
    request = gpiod_chip_request_lines(chip, req_cfg, line_cfg);
    if (!request) {
        fprintf(stderr, "Failed to request GPIO %u/%u: %s\n", d0, d1, strerror(errno));
        gpiod_request_config_free(req_cfg);
        gpiod_line_config_free(line_cfg);
        gpiod_line_settings_free(settings);
        gpiod_chip_close(chip);
        return -1;
    }
    
    // Ensure HIGH before start
    gpiod_line_request_set_value(request, d0, GPIOD_LINE_VALUE_ACTIVE);
    gpiod_line_request_set_value(request, d1, GPIOD_LINE_VALUE_ACTIVE);
    usleep_precise(82000);  // 82ms pre-stabilize
    
    // Send bits
    for (int i = 0; i < bit_count; i++) {
        unsigned int pin = (bits[i] == '0') ? d0 : d1;
        
        gpiod_line_request_set_value(request, pin, GPIOD_LINE_VALUE_INACTIVE);
        usleep_precise(pulse_us);
        gpiod_line_request_set_value(request, pin, GPIOD_LINE_VALUE_ACTIVE);
        
        if (i < bit_count - 1) {
            usleep_precise(INTER_PULSE_US);
        }
    }
    
    // Hold HIGH after transmission
    usleep_precise(10000);  // 10ms post-hold
    
    gpiod_line_request_release(request);
    gpiod_request_config_free(req_cfg);
    gpiod_line_config_free(line_cfg);
    gpiod_line_settings_free(settings);
    gpiod_chip_close(chip);
    
    return 0;
}

void print_usage(const char* prog) {
    fprintf(stderr, "Usage:\n");
    fprintf(stderr, "  %s <d0> <d1> <facility> <card> <bits> [pulse_us]  - Encode & send\n", prog);
    fprintf(stderr, "  %s -r <d0> <d1> <bitstring> [pulse_us]            - Send raw bits\n", prog);
    fprintf(stderr, "\nExamples:\n");
    fprintf(stderr, "  %s 22 23 80 12345 26           # 26-bit FC=80 Card=12345\n", prog);
    fprintf(stderr, "  %s -r 22 23 10101010101010101010101010  # Raw 26 bits\n", prog);
}

int main(int argc, char *argv[]) {
    // RAW MODE: -r <d0> <d1> <bitstring> [pulse_us]
    if (argc >= 5 && strcmp(argv[1], "-r") == 0) {
        unsigned int d0 = atoi(argv[2]);
        unsigned int d1 = atoi(argv[3]);
        const char* bits = argv[4];
        int pulse = (argc >= 6) ? atoi(argv[5]) : DEFAULT_PULSE_US;
        
        // Validate bitstring
        int len = strlen(bits);
        for (int i = 0; i < len; i++) {
            if (bits[i] != '0' && bits[i] != '1') {
                fprintf(stderr, "Error: Bitstring must contain only 0 and 1\n");
                return 1;
            }
        }
        
        printf("=== Wiegand TX RAW (GPIO %u/%u) ===\n", d0, d1);
        printf("Bits: %s (%d)\n", bits, len);
        printf("Pulse: %dus\n", pulse);
        
        if (send_wiegand(d0, d1, bits, pulse) == 0) {
            printf("✓ Sent!\n");
            return 0;
        }
        return 1;
    }
    
    // ENCODE MODE: <d0> <d1> <facility> <card> <bits> [pulse_us]
    if (argc < 6) {
        print_usage(argv[0]);
        return 1;
    }
    
    unsigned int d0 = atoi(argv[1]);
    unsigned int d1 = atoi(argv[2]);
    uint64_t fac = strtoull(argv[3], NULL, 10);
    uint64_t card = strtoull(argv[4], NULL, 10);
    int bits = atoi(argv[5]);
    int pulse = (argc >= 7) ? atoi(argv[6]) : DEFAULT_PULSE_US;
    
    char encoded[MAX_BITS + 1];
    
    printf("=== Wiegand TX (GPIO %u/%u) ===\n", d0, d1);
    
    switch (bits) {
        case 26:
            printf("W26: FC=%lu Card=%lu\n", fac, card);
            encode_w26(fac, card, encoded);
            break;
        case 34:
            printf("W34: FC=%lu Card=%lu\n", fac, card);
            encode_w34(fac, card, encoded);
            break;
        case 37:
            printf("W37: FC=%lu Card=%lu\n", fac, card);
            encode_w37(fac, card, encoded);
            break;
        default:
            fprintf(stderr, "Unsupported format: %d\n", bits);
            fprintf(stderr, "Supported: 26, 34, 37 (or use -r for raw)\n");
            return 1;
    }
    
    printf("Binary: %s (%d bits)\n", encoded, (int)strlen(encoded));
    
    for (int r = 0; r < 1; r++) {
        if (send_wiegand(d0, d1, encoded, pulse) != 0) return 1;
        if (r < 1) usleep_precise(100000);
    }
    printf("✓ Sent 1x!\n");
    return 0;
}
