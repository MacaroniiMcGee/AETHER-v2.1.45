#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <gpiod.h>

#define PULSE_US 50
#define INTER_PULSE_US 1000

void usleep_precise(unsigned int usec) {
    struct timespec ts;
    ts.tv_sec = usec / 1000000;
    ts.tv_nsec = (usec % 1000000) * 1000;
    nanosleep(&ts, NULL);
}

void send_bits(struct gpiod_line_request *req, unsigned int d0, unsigned int d1, const char *bits) {
    int len = strlen(bits);
    for (int i = 0; i < len; i++) {
        unsigned int pin = (bits[i] == '0') ? d0 : d1;
        gpiod_line_request_set_value(req, pin, GPIOD_LINE_VALUE_INACTIVE);
        usleep_precise(PULSE_US);
        gpiod_line_request_set_value(req, pin, GPIOD_LINE_VALUE_ACTIVE);
        if (i < len - 1) usleep_precise(INTER_PULSE_US);
    }
    usleep_precise(10000);
}

void encode_w26(int fac, int card, char *out) {
    char data[25];
    for (int i = 7; i >= 0; i--) data[7-i] = ((fac >> i) & 1) + '0';
    for (int i = 15; i >= 0; i--) data[8+(15-i)] = ((card >> i) & 1) + '0';
    data[24] = 0;
    int ep = 0, op = 0;
    for (int i = 0; i < 12; i++) if (data[i] == '1') ep++;
    for (int i = 12; i < 24; i++) if (data[i] == '1') op++;
    sprintf(out, "%d%s%d", ep % 2, data, (op + 1) % 2);
}

int main(int argc, char *argv[]) {
    if (argc < 6) {
        printf("Usage: %s <d0> <d1> <facility> <start_card> <end_card>\n", argv[0]);
        return 1;
    }
    
    unsigned int d0 = atoi(argv[1]), d1 = atoi(argv[2]);
    int fac = atoi(argv[3]), start = atoi(argv[4]), end = atoi(argv[5]);
    
    struct gpiod_chip *chip = gpiod_chip_open("/dev/gpiochip0");
    if (!chip) { fprintf(stderr, "Failed to open chip\n"); return 1; }
    
    struct gpiod_line_settings *settings = gpiod_line_settings_new();
    gpiod_line_settings_set_direction(settings, GPIOD_LINE_DIRECTION_OUTPUT);
    gpiod_line_settings_set_output_value(settings, GPIOD_LINE_VALUE_ACTIVE);
    
    struct gpiod_line_config *line_cfg = gpiod_line_config_new();
    gpiod_line_config_add_line_settings(line_cfg, &d0, 1, settings);
    gpiod_line_config_add_line_settings(line_cfg, &d1, 1, settings);
    
    struct gpiod_request_config *req_cfg = gpiod_request_config_new();
    gpiod_request_config_set_consumer(req_cfg, "burst_tx");
    
    struct gpiod_line_request *req = gpiod_chip_request_lines(chip, req_cfg, line_cfg);
    if (!req) { fprintf(stderr, "Failed to request GPIO\n"); return 1; }
    
    printf("=== BURST TEST START ===\n");
    printf("GPIO %d/%d acquired\n", d0, d1);
    printf("Sending cards %d to %d\n\n", start, end);
    fflush(stdout);
    
    int count = 0;
    for (int card = start; card <= end; card++) {
        char bits[27];
        encode_w26(fac, card, bits);
        printf("[%d] Sending FC=%d Card=%d: %s\n", ++count, fac, card, bits);
        fflush(stdout);
        send_bits(req, d0, d1, bits);
        printf("[%d] Sent. Waiting 1s...\n", count);
        fflush(stdout);
        usleep_precise(1000000);
    }
    
    printf("\n=== ALL %d CARDS SENT ===\n", count);
    fflush(stdout);
    
    usleep_precise(50000);
    gpiod_line_request_release(req);
    gpiod_chip_close(chip);
    printf("GPIO released. Done!\n");
    return 0;
}
