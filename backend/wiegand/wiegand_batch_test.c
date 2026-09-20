#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <gpiod.h>

#define PULSE_US 100
#define INTER_PULSE_US 1000

void usleep_precise(unsigned int usec) {
    struct timespec ts = { usec / 1000000, (usec % 1000000) * 1000 };
    nanosleep(&ts, NULL);
}

void int_to_binary(unsigned int value, char* output, int bits) {
    for (int i = bits - 1; i >= 0; i--)
        output[bits - 1 - i] = ((value >> i) & 1) ? '1' : '0';
    output[bits] = '\0';
}

int calc_even_parity(const char* bits, int len) {
    int c = 0;
    for (int i = 0; i < len; i++) if (bits[i] == '1') c++;
    return (c % 2 == 0) ? 0 : 1;
}

int calc_odd_parity(const char* bits, int len) {
    int c = 0;
    for (int i = 0; i < len; i++) if (bits[i] == '1') c++;
    return (c % 2 == 1) ? 0 : 1;
}

void encode_w26(unsigned int fac, unsigned int card, char* out) {
    char data[25];
    int_to_binary(fac, data, 8);
    int_to_binary(card, data + 8, 16);
    sprintf(out, "%d%s%d", calc_even_parity(data, 12), data, calc_odd_parity(data + 12, 12));
}

int main(int argc, char* argv[]) {
    if (argc < 6) {
        printf("Usage: %s <d0> <d1> <facility> <start_card> <count> [delay_ms]\n", argv[0]);
        printf("Example: %s 22 23 80 1401 10 500\n", argv[0]);
        return 1;
    }
    
    unsigned int d0 = atoi(argv[1]);
    unsigned int d1 = atoi(argv[2]);
    unsigned int fac = atoi(argv[3]);
    unsigned int start_card = atoi(argv[4]);
    int count = atoi(argv[5]);
    int delay_ms = (argc > 6) ? atoi(argv[6]) : 500;
    
    struct gpiod_chip *chip = gpiod_chip_open("/dev/gpiochip0");
    if (!chip) { fprintf(stderr, "Failed to open chip\n"); return 1; }
    
    struct gpiod_line_settings *settings = gpiod_line_settings_new();
    gpiod_line_settings_set_direction(settings, GPIOD_LINE_DIRECTION_OUTPUT);
    gpiod_line_settings_set_output_value(settings, GPIOD_LINE_VALUE_ACTIVE);
    gpiod_line_settings_set_drive(settings, GPIOD_LINE_DRIVE_PUSH_PULL);
    gpiod_line_settings_set_bias(settings, GPIOD_LINE_BIAS_DISABLED);
    
    struct gpiod_line_config *line_cfg = gpiod_line_config_new();
    gpiod_line_config_add_line_settings(line_cfg, &d0, 1, settings);
    gpiod_line_config_add_line_settings(line_cfg, &d1, 1, settings);
    
    struct gpiod_request_config *req_cfg = gpiod_request_config_new();
    gpiod_request_config_set_consumer(req_cfg, "wiegand_batch");
    
    struct gpiod_line_request *req = gpiod_chip_request_lines(chip, req_cfg, line_cfg);
    if (!req) { fprintf(stderr, "Failed to request GPIO\n"); return 1; }
    
    printf("=== BATCH MODE: GPIO %u/%u held open ===\n", d0, d1);
    printf("Sending %d cards (FC=%u, Cards %u-%u)\n", count, fac, start_card, start_card + count - 1);
    printf("Delay between cards: %dms\n\n", delay_ms);
    
    // Ensure HIGH
    gpiod_line_request_set_value(req, d0, GPIOD_LINE_VALUE_ACTIVE);
    gpiod_line_request_set_value(req, d1, GPIOD_LINE_VALUE_ACTIVE);
    usleep_precise(100000);  // 100ms initial stabilize
    
    for (int i = 0; i < count; i++) {
        unsigned int card = start_card + i;
        char bits[27];
        encode_w26(fac, card, bits);
        
        printf("[%2d] FC=%u Card=%u -> %s\n", i+1, fac, card, bits);
        
        // Send bits
        int len = strlen(bits);
        for (int b = 0; b < len; b++) {
            unsigned int pin = (bits[b] == '0') ? d0 : d1;
            gpiod_line_request_set_value(req, pin, GPIOD_LINE_VALUE_INACTIVE);
            usleep_precise(PULSE_US);
            gpiod_line_request_set_value(req, pin, GPIOD_LINE_VALUE_ACTIVE);
            if (b < len - 1) usleep_precise(INTER_PULSE_US);
        }
        
        // Wait between cards (keep GPIO held HIGH)
        if (i < count - 1) {
            usleep_precise(delay_ms * 1000);
        }
    }
    
    // Hold HIGH before release
    usleep_precise(100000);
    
    gpiod_line_request_release(req);
    gpiod_request_config_free(req_cfg);
    gpiod_line_config_free(line_cfg);
    gpiod_line_settings_free(settings);
    gpiod_chip_close(chip);
    
    printf("\n✓ Batch complete!\n");
    return 0;
}
