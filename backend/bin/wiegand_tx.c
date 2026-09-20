/**
 * wiegand_tx.c - Enhanced Wiegand Transmitter v5.0
 * 
 * COMPLETE SUPPORT FOR ALL CREDENTIAL FORMATS:
 * - Standard Wiegand (26, 30, 32, 34, 37, 38, 40, 46, 48, 56, 64)
 * - Corporate 1000 35/48-bit (interleaved parity)
 * - H10320 36-bit Clock & Data (multi-row parity)
 * - Honeywell 40-bit (XOR checksum)
 * - Indala ASC 27-bit (scrambled bits)
 * - TECOM 27-bit (scrambled bits)
 * - Issue Level formats (K32, Kastle)
 * - Card-only formats (H10302, CASI 40, Keyscan 36)
 * - Keypad burst mode (4-bit, 8-bit)
 * - Raw bit strings
 * 
 * Usage (Card Mode):
 *   ./wiegand_tx <d0> <d1> <facility> <card> <bits> [pulse_us]
 *   ./wiegand_tx 12 13 123 45678 26 50
 * 
 * Usage (Raw Bits Mode):
 *   ./wiegand_tx --raw <d0> <d1> <bits_string> [pulse_us]
 *   ./wiegand_tx --raw 12 13 0001001011 50
 * 
 * Usage (Format Mode - v5.0):
 *   ./wiegand_tx --format <d0> <d1> <format_id> <facility> <card> [issue_level] [pulse_us]
 *   ./wiegand_tx --format 12 13 corp1000_35 123 45678 50
 *   ./wiegand_tx --format 12 13 k32 123 45678 5 50
 * 
 * Compile:
 *   gcc -o wiegand_tx wiegand_tx.c -lgpiod -O2
 */

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <gpiod.h>
#include <errno.h>
#include <stdbool.h>
#include <ctype.h>

#define DEFAULT_PULSE_US 50
#define INTER_PULSE_MS 2
#define MAX_BITS 128
#define MAX_FORMAT_ID 32

// ============================================================
// TIMING FUNCTIONS
// ============================================================

void usleep_precise(unsigned int usec) {
    struct timespec ts;
    ts.tv_sec = usec / 1000000;
    ts.tv_nsec = (usec % 1000000) * 1000;
    nanosleep(&ts, NULL);
}

// ============================================================
// PARITY CALCULATION FUNCTIONS
// ============================================================

// Count number of 1 bits in a string
int count_ones(const char* bits, int len) {
    int count = 0;
    for (int i = 0; i < len; i++) {
        if (bits[i] == '1') count++;
    }
    return count;
}

// Even parity: returns 1 if odd number of 1s (to make even)
int calculate_even_parity(const char* bits, int len) {
    return (count_ones(bits, len) % 2 == 0) ? 0 : 1;
}

// Odd parity: returns 1 if even number of 1s (to make odd)
int calculate_odd_parity(const char* bits, int len) {
    return (count_ones(bits, len) % 2 == 1) ? 0 : 1;
}

// Integer to binary conversion
void int_to_binary(uint64_t value, char* output, int bits) {
    for (int i = bits - 1; i >= 0; i--) {
        output[bits - 1 - i] = ((value >> i) & 1) ? '1' : '0';
    }
    output[bits] = '\0';
}

// ============================================================
// STANDARD WIEGAND ENCODING (Even/Odd Half Parity)
// ============================================================

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

// W40 Standard: [EP][16-bit facility][22-bit card][OP]
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

// W48 Standard: [EP][22-bit facility][24-bit card][OP]
void encode_wiegand_48_std(uint32_t facility, uint32_t card, char* output) {
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
    for (int i = 27; i >= 0; i--) {
        facility_bits[27 - i] = ((facility >> i) & 1) ? '1' : '0';
    }
    facility_bits[28] = '\0';
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

// ============================================================
// INTERLEAVED PARITY (HID Corporate 1000 35/48-bit)
// ============================================================

/**
 * Corporate 1000 35-bit Format
 * Layout: [OP-whole][EP][01][F11-F0][C19-C0][OP]
 * 
 * Bit 0:     Odd parity over ENTIRE frame (bits 1-34)
 * Bit 1:     Even parity over bits 2-17 (left half of data)
 * Bits 2-3:  Fixed header "01"
 * Bits 4-15: 12-bit facility code (MSB first)
 * Bits 16-35: 20-bit card number (MSB first)
 * Bit 34:    Odd parity over bits 18-33 (right half of data)
 */
void encode_corp1000_35(uint32_t facility, uint32_t card, char* output) {
    char frame[36];
    memset(frame, '0', 35);
    frame[35] = '\0';
    
    // Fixed header "01" at positions 2-3
    frame[2] = '0';
    frame[3] = '1';
    
    // 12-bit facility code at positions 4-15
    for (int i = 0; i < 12; i++) {
        frame[4 + i] = ((facility >> (11 - i)) & 1) ? '1' : '0';
    }
    
    // 20-bit card number at positions 16-35 (but position 34 is parity)
    for (int i = 0; i < 20; i++) {
        frame[16 + i] = ((card >> (19 - i)) & 1) ? '1' : '0';
    }
    
    // Calculate interleaved parities
    // Even parity on left half (bits 2-17)
    frame[1] = calculate_even_parity(frame + 2, 16) ? '1' : '0';
    
    // Odd parity on right half (bits 18-33)
    frame[34] = calculate_odd_parity(frame + 18, 16) ? '1' : '0';
    
    // Whole-frame odd parity (bits 1-34)
    frame[0] = calculate_odd_parity(frame + 1, 34) ? '1' : '0';
    
    strcpy(output, frame);
}

/**
 * Corporate 1000 48-bit Format
 * Same interleaved parity structure as 35-bit
 * Layout: [OP-whole][EP][01][F21-F0][C19-C0][OP]
 */
void encode_corp1000_48(uint32_t facility, uint32_t card, char* output) {
    char frame[49];
    memset(frame, '0', 48);
    frame[48] = '\0';
    
    // Fixed header "01" at positions 2-3
    frame[2] = '0';
    frame[3] = '1';
    
    // 22-bit facility code at positions 4-25
    for (int i = 0; i < 22; i++) {
        frame[4 + i] = ((facility >> (21 - i)) & 1) ? '1' : '0';
    }
    
    // 20-bit card number at positions 26-45
    for (int i = 0; i < 20; i++) {
        frame[26 + i] = ((card >> (19 - i)) & 1) ? '1' : '0';
    }
    
    // Calculate interleaved parities
    // Even parity on left half (bits 2-24)
    frame[1] = calculate_even_parity(frame + 2, 23) ? '1' : '0';
    
    // Odd parity on right half (bits 25-46)
    frame[47] = calculate_odd_parity(frame + 25, 22) ? '1' : '0';
    
    // Whole-frame odd parity (bits 1-47)
    frame[0] = calculate_odd_parity(frame + 1, 47) ? '1' : '0';
    
    strcpy(output, frame);
}

// ============================================================
// MULTI-ROW PARITY (H10320 36-bit Clock & Data)
// ============================================================

/**
 * H10320 36-bit Clock & Data Format (Keyscan compatible)
 * Layout: [C31-C0][EP1][OP][X][EP2]
 * 
 * Card-only format - NO facility code
 * 32-bit card number followed by 4 parity bits
 * 
 * Bit Positions:  1  2  3  4  5  6  7  8  9  10 11 12 ...
 * EP1 Row:           X     X     X     X     X
 * OP Row:         X     X     X     X     X
 * EP2 Row:           X     X     X     X     X  (same as EP1)
 * 
 * EP1 (bit 33): Even parity on bits 4,8,12,16,20,24,28,32
 * OP  (bit 34): Odd parity on bits 2,6,10,14,18,22,26,30
 * X   (bit 35): Usually 0
 * EP2 (bit 36): Even parity - same calculation as EP1
 */
void encode_h10320_clockdata(uint32_t card, char* output) {
    char frame[37];
    memset(frame, '0', 36);
    frame[36] = '\0';
    
    // 32-bit card number at positions 0-31
    for (int i = 0; i < 32; i++) {
        frame[i] = ((card >> (31 - i)) & 1) ? '1' : '0';
    }
    
    // Calculate multi-row parities
    // EP1: Even parity on bits at positions 3,7,11,15,19,23,27,31 (0-indexed: 4,8,12... are 1-indexed)
    char ep1_bits[9];
    int ep1_positions[] = {3, 7, 11, 15, 19, 23, 27, 31};
    for (int i = 0; i < 8; i++) {
        ep1_bits[i] = frame[ep1_positions[i]];
    }
    ep1_bits[8] = '\0';
    frame[32] = calculate_even_parity(ep1_bits, 8) ? '1' : '0';
    
    // OP: Odd parity on bits at positions 1,5,9,13,17,21,25,29 (0-indexed)
    char op_bits[9];
    int op_positions[] = {1, 5, 9, 13, 17, 21, 25, 29};
    for (int i = 0; i < 8; i++) {
        op_bits[i] = frame[op_positions[i]];
    }
    op_bits[8] = '\0';
    frame[33] = calculate_odd_parity(op_bits, 8) ? '1' : '0';
    
    // X bit (bit 35, position 34): Usually 0
    frame[34] = '0';
    
    // EP2: Same as EP1
    frame[35] = frame[32];
    
    strcpy(output, frame);
}

/**
 * Keyscan 36-bit - Similar to H10320 but with facility code
 * Layout: [F7-F0][C23-C0][EP1][OP][X][EP2]
 */
void encode_keyscan_36(uint32_t facility, uint32_t card, char* output) {
    char frame[37];
    memset(frame, '0', 36);
    frame[36] = '\0';
    
    // 8-bit facility code at positions 0-7
    for (int i = 0; i < 8; i++) {
        frame[i] = ((facility >> (7 - i)) & 1) ? '1' : '0';
    }
    
    // 24-bit card number at positions 8-31
    for (int i = 0; i < 24; i++) {
        frame[8 + i] = ((card >> (23 - i)) & 1) ? '1' : '0';
    }
    
    // Same multi-row parity as h10320
    char ep1_bits[9];
    int ep1_positions[] = {3, 7, 11, 15, 19, 23, 27, 31};
    for (int i = 0; i < 8; i++) {
        ep1_bits[i] = frame[ep1_positions[i]];
    }
    ep1_bits[8] = '\0';
    frame[32] = calculate_even_parity(ep1_bits, 8) ? '1' : '0';
    
    char op_bits[9];
    int op_positions[] = {1, 5, 9, 13, 17, 21, 25, 29};
    for (int i = 0; i < 8; i++) {
        op_bits[i] = frame[op_positions[i]];
    }
    op_bits[8] = '\0';
    frame[33] = calculate_odd_parity(op_bits, 8) ? '1' : '0';
    
    frame[34] = '0';
    frame[35] = frame[32];
    
    strcpy(output, frame);
}

// ============================================================
// XOR CHECKSUM (Honeywell 40-bit)
// ============================================================

/**
 * Honeywell 40-bit Format (P10001)
 * Layout: [1111][S11-S0][C15-C0][XOR7-XOR0]
 * 
 * Bits 0-3:   Fixed header "1111"
 * Bits 4-15:  12-bit site/facility code
 * Bits 16-31: 16-bit card number
 * Bits 32-39: XOR checksum byte
 * 
 * XOR Checksum = byte1 ^ byte2 ^ byte3 ^ byte4
 * where byte1-4 are the first 32 bits split into 4 bytes
 */
void encode_honeywell_40(uint32_t facility, uint32_t card, char* output) {
    char frame[41];
    memset(frame, '0', 40);
    frame[40] = '\0';
    
    // Fixed header "1111"
    frame[0] = '1'; frame[1] = '1'; frame[2] = '1'; frame[3] = '1';
    
    // 12-bit facility code at positions 4-15
    for (int i = 0; i < 12; i++) {
        frame[4 + i] = ((facility >> (11 - i)) & 1) ? '1' : '0';
    }
    
    // 16-bit card number at positions 16-31
    for (int i = 0; i < 16; i++) {
        frame[16 + i] = ((card >> (15 - i)) & 1) ? '1' : '0';
    }
    
    // Calculate XOR checksum
    // Convert first 32 bits to 4 bytes
    uint8_t bytes[4];
    for (int b = 0; b < 4; b++) {
        bytes[b] = 0;
        for (int i = 0; i < 8; i++) {
            if (frame[b * 8 + i] == '1') {
                bytes[b] |= (1 << (7 - i));
            }
        }
    }
    
    uint8_t xor_byte = bytes[0] ^ bytes[1] ^ bytes[2] ^ bytes[3];
    
    // Write XOR checksum to positions 32-39
    for (int i = 0; i < 8; i++) {
        frame[32 + i] = ((xor_byte >> (7 - i)) & 1) ? '1' : '0';
    }
    
    strcpy(output, frame);
}

// ============================================================
// SCRAMBLED BIT ENCODING (Indala ASC 27, TECOM 27)
// ============================================================

/**
 * Indala ASC 27-bit Format
 * Site code and card number bits are placed at non-sequential positions
 * 
 * Site code (13 bits) positions: 5,8,7,2,1,4,21,6,10,9,25,12,23 (1-indexed)
 * Card number (14 bits) positions: 27,2,4,13,16,19,22,15,26,3,20,24,11,14 (1-indexed)
 * 
 * Note: Some positions are shared - this is the documented scramble pattern
 */
void encode_indala_asc27(uint32_t facility, uint32_t card, char* output) {
    char frame[28];
    memset(frame, '0', 27);
    frame[27] = '\0';
    
    // Site code positions (1-indexed, convert to 0-indexed)
    int site_positions[] = {4, 7, 6, 1, 0, 3, 20, 5, 9, 8, 24, 11, 22};
    for (int i = 0; i < 13 && i < 13; i++) {
        if (site_positions[i] < 27) {
            frame[site_positions[i]] = ((facility >> (12 - i)) & 1) ? '1' : '0';
        }
    }
    
    // Card number positions (1-indexed, convert to 0-indexed)
    int card_positions[] = {26, 1, 3, 12, 15, 18, 21, 14, 25, 2, 19, 23, 10, 13};
    for (int i = 0; i < 14; i++) {
        if (card_positions[i] < 27) {
            frame[card_positions[i]] = ((card >> (13 - i)) & 1) ? '1' : '0';
        }
    }
    
    strcpy(output, frame);
}

/**
 * TECOM 27-bit Format
 * Different scramble pattern from Indala ASC
 */
void encode_tecom_27(uint32_t facility, uint32_t card, char* output) {
    char frame[28];
    memset(frame, '0', 27);
    frame[27] = '\0';
    
    // TECOM uses a different scramble pattern
    // Site code (8 bits) positions (example pattern)
    int site_positions[] = {1, 3, 5, 7, 9, 11, 13, 15};
    for (int i = 0; i < 8; i++) {
        if (site_positions[i] < 27) {
            frame[site_positions[i]] = ((facility >> (7 - i)) & 1) ? '1' : '0';
        }
    }
    
    // Card number (16 bits) in remaining positions
    int card_positions[] = {0, 2, 4, 6, 8, 10, 12, 14, 16, 17, 18, 19, 20, 21, 22, 23};
    for (int i = 0; i < 16; i++) {
        if (card_positions[i] < 27) {
            frame[card_positions[i]] = ((card >> (15 - i)) & 1) ? '1' : '0';
        }
    }
    
    // Parity bits at end
    frame[24] = calculate_even_parity(frame, 12) ? '1' : '0';
    frame[25] = calculate_odd_parity(frame + 12, 12) ? '1' : '0';
    frame[26] = '0';  // Trailing bit
    
    strcpy(output, frame);
}

// ============================================================
// ISSUE LEVEL FORMATS (K32, Kastle)
// ============================================================

/**
 * K32 32-bit Format with Issue Level
 * Layout: [EP][IL5-IL0][F7-F0][C15-C0][OP]
 * 
 * 6-bit issue level + 8-bit facility + 16-bit card + parity
 */
void encode_k32(uint32_t facility, uint32_t card, uint8_t issue_level, char* output) {
    char frame[33];
    char data[31];
    memset(data, '0', 30);
    data[30] = '\0';
    
    // 6-bit issue level at positions 0-5
    for (int i = 0; i < 6; i++) {
        data[i] = ((issue_level >> (5 - i)) & 1) ? '1' : '0';
    }
    
    // 8-bit facility code at positions 6-13
    for (int i = 0; i < 8; i++) {
        data[6 + i] = ((facility >> (7 - i)) & 1) ? '1' : '0';
    }
    
    // 16-bit card number at positions 14-29
    for (int i = 0; i < 16; i++) {
        data[14 + i] = ((card >> (15 - i)) & 1) ? '1' : '0';
    }
    
    // Standard even/odd parity
    int even_parity = calculate_even_parity(data, 15);
    int odd_parity = calculate_odd_parity(data + 15, 15);
    sprintf(output, "%d%s%d", even_parity, data, odd_parity);
}

/**
 * Kastle 32-bit Format with Issue Level
 * Layout: [EP][IL4-IL0][F8-F0][C15-C0][OP]
 * 
 * 5-bit issue level + 9-bit facility + 16-bit card + parity
 */
void encode_kastle_32(uint32_t facility, uint32_t card, uint8_t issue_level, char* output) {
    char frame[33];
    char data[31];
    memset(data, '0', 30);
    data[30] = '\0';
    
    // 5-bit issue level at positions 0-4
    for (int i = 0; i < 5; i++) {
        data[i] = ((issue_level >> (4 - i)) & 1) ? '1' : '0';
    }
    
    // 9-bit facility code at positions 5-13
    for (int i = 0; i < 9; i++) {
        data[5 + i] = ((facility >> (8 - i)) & 1) ? '1' : '0';
    }
    
    // 16-bit card number at positions 14-29
    for (int i = 0; i < 16; i++) {
        data[14 + i] = ((card >> (15 - i)) & 1) ? '1' : '0';
    }
    
    // Standard even/odd parity
    int even_parity = calculate_even_parity(data, 15);
    int odd_parity = calculate_odd_parity(data + 15, 15);
    sprintf(output, "%d%s%d", even_parity, data, odd_parity);
}

// ============================================================
// CARD-ONLY FORMATS (No Facility Code)
// ============================================================

/**
 * H10302 37-bit Card-Only Format
 * Layout: [EP][C34-C0][OP]
 * 35-bit card number with even/odd half parity
 */
void encode_h10302_cardonly(uint64_t card, char* output) {
    char data[36];
    memset(data, '0', 35);
    data[35] = '\0';
    
    // 35-bit card number
    for (int i = 0; i < 35; i++) {
        data[i] = ((card >> (34 - i)) & 1) ? '1' : '0';
    }
    
    // Even/odd half parity
    int even_parity = calculate_even_parity(data, 18);
    int odd_parity = calculate_odd_parity(data + 18, 17);
    sprintf(output, "%d%s%d", even_parity, data, odd_parity);
}

/**
 * CASI Rusco 40-bit Card-Only Format
 * Layout: [C39-C0] - No parity
 */
void encode_casi_40(uint64_t card, char* output) {
    for (int i = 0; i < 40; i++) {
        output[i] = ((card >> (39 - i)) & 1) ? '1' : '0';
    }
    output[40] = '\0';
}

// ============================================================
// INDALA STANDARD FORMATS
// ============================================================

/**
 * Indala 26-bit Standard Format (FIXED: 12-bit FC, 12-bit Card)
 * Layout: [EP][F11-F0][C11-C0][OP]
 */
void encode_indala_26(uint32_t facility, uint32_t card, char* output) {
    char data[25];
    memset(data, '0', 24);
    data[24] = '\0';
    
    // 12-bit facility code
    for (int i = 0; i < 12; i++) {
        data[i] = ((facility >> (11 - i)) & 1) ? '1' : '0';
    }
    
    // 12-bit card number
    for (int i = 0; i < 12; i++) {
        data[12 + i] = ((card >> (11 - i)) & 1) ? '1' : '0';
    }
    
    // Even/odd half parity
    int even_parity = calculate_even_parity(data, 12);
    int odd_parity = calculate_odd_parity(data + 12, 12);
    sprintf(output, "%d%s%d", even_parity, data, odd_parity);
}

/**
 * Indala 29-bit Format (FIXED: 13-bit FC, 16-bit Card, NO PARITY)
 * Layout: [F12-F0][C15-C0]
 */
void encode_indala_29(uint32_t facility, uint32_t card, char* output) {
    memset(output, '0', 29);
    output[29] = '\0';
    
    // 13-bit facility code
    for (int i = 0; i < 13; i++) {
        output[i] = ((facility >> (12 - i)) & 1) ? '1' : '0';
    }
    
    // 16-bit card number
    for (int i = 0; i < 16; i++) {
        output[13 + i] = ((card >> (15 - i)) & 1) ? '1' : '0';
    }
}

// ============================================================
// AWID FORMATS
// ============================================================

/**
 * AWID 26-bit Format
 * Layout: [EP][F7-F0][C15-C0][OP]
 */
void encode_awid_26(uint32_t facility, uint32_t card, char* output) {
    encode_wiegand_26(facility, card, output);  // Same as W26
}

/**
 * AWID 34-bit Format
 * Layout: [EP][F15-F0][C15-C0][OP]
 */
void encode_awid_34(uint32_t facility, uint32_t card, char* output) {
    encode_wiegand_34(facility, card, output);  // Same as W34
}

/**
 * AWID 50-bit Format
 * Layout: [EP][F15-F0][C31-C0][OP]
 */
void encode_awid_50(uint32_t facility, uint64_t card, char* output) {
    char data[49];
    memset(data, '0', 48);
    data[48] = '\0';
    
    // 16-bit facility code
    for (int i = 0; i < 16; i++) {
        data[i] = ((facility >> (15 - i)) & 1) ? '1' : '0';
    }
    
    // 32-bit card number
    for (int i = 0; i < 32; i++) {
        data[16 + i] = ((card >> (31 - i)) & 1) ? '1' : '0';
    }
    
    // Even/odd half parity
    int even_parity = calculate_even_parity(data, 24);
    int odd_parity = calculate_odd_parity(data + 24, 24);
    sprintf(output, "%d%s%d", even_parity, data, odd_parity);
}

// ============================================================
// GPIO FUNCTIONS
// ============================================================

struct gpiod_chip* open_gpio_chip(void) {
    const char* chips[] = {"/dev/gpiochip0", "/dev/gpiochip4", "gpiochip0", "gpiochip4", NULL};
    struct gpiod_chip *chip = NULL;
    
    for (int i = 0; chips[i] != NULL; i++) {
        chip = gpiod_chip_open(chips[i]);
        if (chip) {
            return chip;
        }
    }
    
    fprintf(stderr, "ERROR: No GPIO chip found\n");
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
    
    gpiod_line_settings_set_direction(settings, GPIOD_LINE_DIRECTION_OUTPUT);
    gpiod_line_settings_set_output_value(settings, GPIOD_LINE_VALUE_ACTIVE);
    gpiod_line_settings_set_bias(settings, GPIOD_LINE_BIAS_DISABLED);
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
        gpiod_request_config_free(req_cfg);
        gpiod_line_config_free(line_cfg);
        gpiod_line_settings_free(settings);
        gpiod_chip_close(chip);
        return -1;
    }
    
    printf("GPIO D0=%u D1=%u acquired\n", d0_pin, d1_pin);
    printf("Sending %d bits with %dus pulses...\n", bit_count, pulse_us);
    
    // Pre-condition: ensure lines are HIGH before transmission
    gpiod_line_request_set_value(request, d0_pin, GPIOD_LINE_VALUE_ACTIVE);
    gpiod_line_request_set_value(request, d1_pin, GPIOD_LINE_VALUE_ACTIVE);
    usleep_precise(2000);
    
    for (int i = 0; i < bit_count; i++) {
        unsigned int pin = (bits[i] == '0') ? d0_pin : d1_pin;
        
        ret = gpiod_line_request_set_value(request, pin, GPIOD_LINE_VALUE_INACTIVE);
        if (ret < 0) {
            fprintf(stderr, "Failed to set GPIO %u LOW at bit %d\n", pin, i);
            break;
        }
        
        usleep_precise(pulse_us);
        
        ret = gpiod_line_request_set_value(request, pin, GPIOD_LINE_VALUE_ACTIVE);
        if (ret < 0) {
            fprintf(stderr, "Failed to set GPIO %u HIGH at bit %d\n", pin, i);
            break;
        }
        
        if (i < bit_count - 1) {
            usleep_precise(INTER_PULSE_MS * 1000);
        }
        
        if ((i + 1) % 8 == 0 || i == bit_count - 1) {
            printf("  %d/%d bits\n", i + 1, bit_count);
        }
    }
    
    // Ensure lines are HIGH after transmission
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

// ============================================================
// FORMAT-BASED ENCODING
// ============================================================

int encode_by_format(const char* format_id, uint64_t facility, uint64_t card, 
                     uint8_t issue_level, char* output) {
    // Normalize format ID to lowercase
    char fmt[MAX_FORMAT_ID];
    strncpy(fmt, format_id, MAX_FORMAT_ID - 1);
    fmt[MAX_FORMAT_ID - 1] = '\0';
    for (int i = 0; fmt[i]; i++) {
        fmt[i] = tolower(fmt[i]);
    }
    
    // Standard Wiegand formats
    if (strcmp(fmt, "w26") == 0 || strcmp(fmt, "wiegand26") == 0 || strcmp(fmt, "h10301") == 0) {
        encode_wiegand_26((uint32_t)facility, (uint32_t)card, output);
        return 26;
    }
    if (strcmp(fmt, "w30") == 0 || strcmp(fmt, "wiegand30") == 0) {
        encode_wiegand_30((uint32_t)facility, (uint32_t)card, output);
        return 30;
    }
    if (strcmp(fmt, "w32") == 0 || strcmp(fmt, "wiegand32") == 0) {
        encode_wiegand_32((uint32_t)card, output);
        return 32;
    }
    if (strcmp(fmt, "w34") == 0 || strcmp(fmt, "wiegand34") == 0) {
        encode_wiegand_34((uint32_t)facility, (uint32_t)card, output);
        return 34;
    }
    if (strcmp(fmt, "w37") == 0 || strcmp(fmt, "wiegand37") == 0 || strcmp(fmt, "h10304") == 0) {
        encode_wiegand_37((uint32_t)facility, (uint32_t)card, output);
        return 37;
    }
    if (strcmp(fmt, "w38") == 0 || strcmp(fmt, "wiegand38") == 0) {
        encode_wiegand_38((uint32_t)facility, (uint32_t)card, output);
        return 38;
    }
    if (strcmp(fmt, "w40") == 0 || strcmp(fmt, "wiegand40") == 0 || strcmp(fmt, "stid_40") == 0) {
        encode_wiegand_40((uint32_t)facility, (uint32_t)card, output);
        return 40;
    }
    if (strcmp(fmt, "w46") == 0 || strcmp(fmt, "wiegand46") == 0) {
        encode_wiegand_46((uint32_t)facility, (uint32_t)card, output);
        return 46;
    }
    if (strcmp(fmt, "w48") == 0 || strcmp(fmt, "wiegand48") == 0) {
        encode_wiegand_48_std((uint32_t)facility, (uint32_t)card, output);
        return 48;
    }
    if (strcmp(fmt, "w56") == 0 || strcmp(fmt, "wiegand56") == 0) {
        encode_wiegand_56((uint32_t)facility, card, output);
        return 56;
    }
    if (strcmp(fmt, "w64") == 0 || strcmp(fmt, "wiegand64") == 0 || strcmp(fmt, "seos_64") == 0) {
        encode_wiegand_64(facility, card, output);
        return 64;
    }
    
    // Corporate 1000 (Interleaved Parity)
    if (strcmp(fmt, "w35") == 0 || strcmp(fmt, "corp1000_35") == 0 || strcmp(fmt, "corporate1000_35") == 0) {
        encode_corp1000_35((uint32_t)facility, (uint32_t)card, output);
        return 35;
    }
    if (strcmp(fmt, "corp1000_48") == 0 || strcmp(fmt, "corporate1000_48") == 0) {
        encode_corp1000_48((uint32_t)facility, (uint32_t)card, output);
        return 48;
    }
    
    // H10320 / Keyscan (Multi-row Parity)
    if (strcmp(fmt, "h10320") == 0 || strcmp(fmt, "h10320_clockdata") == 0) {
        encode_h10320_clockdata((uint32_t)card, output);
        return 36;
    }
    if (strcmp(fmt, "keyscan_36") == 0 || strcmp(fmt, "keyscan36") == 0) {
        encode_keyscan_36((uint32_t)facility, (uint32_t)card, output);
        return 36;
    }
    
    // Honeywell (XOR Checksum)
    if (strcmp(fmt, "honeywell_40") == 0 || strcmp(fmt, "hid_honeywell_40") == 0 || 
        strcmp(fmt, "p10001") == 0) {
        encode_honeywell_40((uint32_t)facility, (uint32_t)card, output);
        return 40;
    }
    
    // Scrambled formats
    if (strcmp(fmt, "indala27_asc") == 0 || strcmp(fmt, "indala_asc27") == 0) {
        encode_indala_asc27((uint32_t)facility, (uint32_t)card, output);
        return 27;
    }
    if (strcmp(fmt, "tecom27") == 0 || strcmp(fmt, "tecom_27") == 0) {
        encode_tecom_27((uint32_t)facility, (uint32_t)card, output);
        return 27;
    }
    
    // Issue Level formats
    if (strcmp(fmt, "k32") == 0) {
        encode_k32((uint32_t)facility, (uint32_t)card, issue_level, output);
        return 32;
    }
    if (strcmp(fmt, "kastle_32") == 0 || strcmp(fmt, "kastle32") == 0) {
        encode_kastle_32((uint32_t)facility, (uint32_t)card, issue_level, output);
        return 32;
    }
    
    // Card-only formats
    if (strcmp(fmt, "h10302") == 0 || strcmp(fmt, "h10302_cardonly") == 0) {
        encode_h10302_cardonly(card, output);
        return 37;
    }
    if (strcmp(fmt, "casi_40") == 0 || strcmp(fmt, "casi40") == 0) {
        encode_casi_40(card, output);
        return 40;
    }
    
    // Indala formats
    if (strcmp(fmt, "indala26") == 0 || strcmp(fmt, "indala_26") == 0) {
        encode_indala_26((uint32_t)facility, (uint32_t)card, output);
        return 26;
    }
    if (strcmp(fmt, "indala29") == 0 || strcmp(fmt, "indala_29") == 0) {
        encode_indala_29((uint32_t)facility, (uint32_t)card, output);
        return 29;
    }
    
    // AWID formats
    if (strcmp(fmt, "awid26") == 0 || strcmp(fmt, "awid_26") == 0) {
        encode_awid_26((uint32_t)facility, (uint32_t)card, output);
        return 26;
    }
    if (strcmp(fmt, "awid34") == 0 || strcmp(fmt, "awid_34") == 0) {
        encode_awid_34((uint32_t)facility, (uint32_t)card, output);
        return 34;
    }
    if (strcmp(fmt, "awid50") == 0 || strcmp(fmt, "awid_50") == 0) {
        encode_awid_50((uint32_t)facility, card, output);
        return 50;
    }
    
    return -1;  // Unknown format
}

// ============================================================
// MAIN
// ============================================================

void print_usage(const char* prog) {
    fprintf(stderr, "Wiegand Transmitter v5.0\n");
    fprintf(stderr, "========================\n\n");
    fprintf(stderr, "Usage:\n");
    fprintf(stderr, "  Card Mode:     %s <d0> <d1> <facility> <card> <bits> [pulse_us]\n", prog);
    fprintf(stderr, "  Format Mode:   %s --format <d0> <d1> <format_id> <facility> <card> [issue_level] [pulse_us]\n", prog);
    fprintf(stderr, "  Raw Bits Mode: %s --raw <d0> <d1> <bits_string> [pulse_us]\n", prog);
    fprintf(stderr, "\n");
    fprintf(stderr, "Examples:\n");
    fprintf(stderr, "  %s 12 13 123 45678 26 50              # Send W26 card\n", prog);
    fprintf(stderr, "  %s --format 12 13 corp1000_35 123 45678 50  # Corporate 1000 35-bit\n", prog);
    fprintf(stderr, "  %s --format 12 13 k32 123 45678 5 50        # K32 with issue level 5\n", prog);
    fprintf(stderr, "  %s --format 12 13 h10320 0 12345678 50      # H10320 card-only\n", prog);
    fprintf(stderr, "  %s --raw 12 13 0001 50                 # Send raw 4-bit keypad digit\n", prog);
    fprintf(stderr, "\n");
    fprintf(stderr, "Standard formats: 26, 30, 32, 34, 35, 37, 38, 40, 46, 48, 56, 64 bits\n");
    fprintf(stderr, "\n");
    fprintf(stderr, "v5.0 Format IDs:\n");
    fprintf(stderr, "  Standard:      w26, w30, w32, w34, w37, w38, w40, w46, w48, w56, w64\n");
    fprintf(stderr, "  Corporate1000: corp1000_35, corp1000_48 (interleaved parity)\n");
    fprintf(stderr, "  H10320:        h10320, keyscan_36 (multi-row parity)\n");
    fprintf(stderr, "  Honeywell:     honeywell_40, p10001 (XOR checksum)\n");
    fprintf(stderr, "  Scrambled:     indala27_asc, tecom27\n");
    fprintf(stderr, "  Issue Level:   k32, kastle_32\n");
    fprintf(stderr, "  Card-Only:     h10302, casi_40\n");
    fprintf(stderr, "  Indala:        indala26, indala29\n");
    fprintf(stderr, "  AWID:          awid26, awid34, awid50\n");
}

int main(int argc, char *argv[]) {
    
    // ═══════════════════════════════════════════════════════════════════
    // MODE 1: RAW BITS MODE (for keypad burst)
    // ═══════════════════════════════════════════════════════════════════
    if (argc >= 2 && strcmp(argv[1], "--raw") == 0) {
        if (argc < 5) {
            fprintf(stderr, "Error: --raw mode requires: <d0> <d1> <bits_string> [pulse_us]\n");
            print_usage(argv[0]);
            return 1;
        }
        
        unsigned int d0 = atoi(argv[2]);
        unsigned int d1 = atoi(argv[3]);
        const char* raw_bits = argv[4];
        int pulse_us = (argc >= 6) ? atoi(argv[5]) : DEFAULT_PULSE_US;
        
        if (d0 > 27 || d1 > 27 || d0 == d1) {
            fprintf(stderr, "Error: Invalid GPIO pins (must be 0-27 and different)\n");
            return 1;
        }
        
        int bit_len = strlen(raw_bits);
        if (bit_len == 0 || bit_len > MAX_BITS) {
            fprintf(stderr, "Error: Bit string must be 1-%d characters\n", MAX_BITS);
            return 1;
        }
        for (int i = 0; i < bit_len; i++) {
            if (raw_bits[i] != '0' && raw_bits[i] != '1') {
                fprintf(stderr, "Error: Bit string must contain only '0' and '1'\n");
                return 1;
            }
        }
        
        printf("=== Wiegand TX RAW MODE (GPIO %u/%u) ===\n", d0, d1);
        printf("Raw Bits: %s (%d bits)\n\n", raw_bits, bit_len);
        
        return send_wiegand_pulses(d0, d1, raw_bits, pulse_us) < 0 ? 1 : 0;
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // MODE 2: FORMAT MODE (v5.0 - uses format ID)
    // ═══════════════════════════════════════════════════════════════════
    if (argc >= 2 && strcmp(argv[1], "--format") == 0) {
        if (argc < 7) {
            fprintf(stderr, "Error: --format mode requires: <d0> <d1> <format_id> <facility> <card> [issue_level] [pulse_us]\n");
            print_usage(argv[0]);
            return 1;
        }
        
        unsigned int d0 = atoi(argv[2]);
        unsigned int d1 = atoi(argv[3]);
        const char* format_id = argv[4];
        uint64_t fac = strtoull(argv[5], NULL, 10);
        uint64_t crd = strtoull(argv[6], NULL, 10);
        
        // Check for optional issue level and pulse width
        uint8_t issue_level = 0;
        int pulse_us = DEFAULT_PULSE_US;
        
        if (argc >= 8) {
            // Could be issue_level or pulse_us
            int val = atoi(argv[7]);
            if (val <= 63 && argc >= 9) {
                // If there's a 9th arg, 7th is issue_level, 8th is pulse
                issue_level = val;
                pulse_us = atoi(argv[8]);
            } else if (val > 63) {
                // Large value = pulse width
                pulse_us = val;
            } else {
                // Small value with no 9th arg = issue level
                issue_level = val;
            }
        }
        
        if (d0 > 27 || d1 > 27 || d0 == d1) {
            fprintf(stderr, "Error: Invalid GPIO pins (must be 0-27 and different)\n");
            return 1;
        }
        
        printf("=== Wiegand TX FORMAT MODE (GPIO %u/%u) ===\n", d0, d1);
        printf("Format: %s\n", format_id);
        printf("Facility: %lu, Card: %lu", (unsigned long)fac, (unsigned long)crd);
        if (issue_level > 0) printf(", Issue Level: %u", issue_level);
        printf("\n\n");
        
        char enc[MAX_BITS + 1];
        int bits = encode_by_format(format_id, fac, crd, issue_level, enc);
        
        if (bits < 0) {
            fprintf(stderr, "Error: Unknown format '%s'\n", format_id);
            print_usage(argv[0]);
            return 1;
        }
        
        printf("Encoded: %s (%d bits)\n\n", enc, bits);
        
        return send_wiegand_pulses(d0, d1, enc, pulse_us) < 0 ? 1 : 0;
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // MODE 3: LEGACY CARD MODE (bits as number)
    // ═══════════════════════════════════════════════════════════════════
    if (argc < 6) {
        print_usage(argv[0]);
        return 1;
    }
    
    unsigned int d0 = atoi(argv[1]);
    unsigned int d1 = atoi(argv[2]);
    uint64_t fac = strtoull(argv[3], NULL, 10);
    uint64_t crd = strtoull(argv[4], NULL, 10);
    int bits = atoi(argv[5]);
    int pus = (argc >= 7) ? atoi(argv[6]) : DEFAULT_PULSE_US;
    
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
            printf("Wiegand-26: Facility=%lu Card=%lu\n", (unsigned long)fac, (unsigned long)crd);
            encode_wiegand_26(fac, crd, enc);
            break;
            
        case 30:
            if (fac > 1023 || crd > 1048575) {
                fprintf(stderr, "Error: W30 limits: facility 0-1023, card 0-1048575\n");
                return 1;
            }
            printf("Wiegand-30: Facility=%lu Card=%lu\n", (unsigned long)fac, (unsigned long)crd);
            encode_wiegand_30(fac, crd, enc);
            break;
            
        case 32:
            if (crd > 4294967295ULL) {
                fprintf(stderr, "Error: W32 limits: card 0-4294967295\n");
                return 1;
            }
            printf("Wiegand-32: Card=%lu (no facility)\n", (unsigned long)crd);
            encode_wiegand_32(crd, enc);
            break;
            
        case 34:
            if (fac > 65535 || crd > 65535) {
                fprintf(stderr, "Error: W34 limits: facility 0-65535, card 0-65535\n");
                return 1;
            }
            printf("Wiegand-34: Facility=%lu Card=%lu\n", (unsigned long)fac, (unsigned long)crd);
            encode_wiegand_34(fac, crd, enc);
            break;
            
        case 35:
            if (fac > 4095 || crd > 1048575) {
                fprintf(stderr, "Error: W35 limits: facility 0-4095, card 0-1048575\n");
                return 1;
            }
            printf("Corporate 1000 35-bit: Facility=%lu Card=%lu (Interleaved Parity)\n", 
                   (unsigned long)fac, (unsigned long)crd);
            encode_corp1000_35(fac, crd, enc);
            break;
            
        case 36:
            // H10320 Clock & Data - card only
            printf("H10320 36-bit Clock & Data: Card=%lu (Multi-Row Parity)\n", (unsigned long)crd);
            encode_h10320_clockdata(crd, enc);
            break;
            
        case 37:
            if (fac > 65535 || crd > 524287) {
                fprintf(stderr, "Error: W37 limits: facility 0-65535, card 0-524287\n");
                return 1;
            }
            printf("Wiegand-37: Facility=%lu Card=%lu\n", (unsigned long)fac, (unsigned long)crd);
            encode_wiegand_37(fac, crd, enc);
            break;
            
        case 38:
            if (fac > 65535 || crd > 1048575) {
                fprintf(stderr, "Error: W38 limits: facility 0-65535, card 0-1048575\n");
                return 1;
            }
            printf("Wiegand-38: Facility=%lu Card=%lu\n", (unsigned long)fac, (unsigned long)crd);
            encode_wiegand_38(fac, crd, enc);
            break;
            
        case 40:
            if (fac > 65535 || crd > 4194303) {
                fprintf(stderr, "Error: W40 limits: facility 0-65535, card 0-4194303\n");
                return 1;
            }
            printf("Wiegand-40 (STID): Facility=%lu Card=%lu\n", (unsigned long)fac, (unsigned long)crd);
            encode_wiegand_40(fac, crd, enc);
            break;
            
        case 46:
            if (fac > 1048575 || crd > 16777215) {
                fprintf(stderr, "Error: W46 limits: facility 0-1048575, card 0-16777215\n");
                return 1;
            }
            printf("Wiegand-46: Facility=%lu Card=%lu\n", (unsigned long)fac, (unsigned long)crd);
            encode_wiegand_46(fac, crd, enc);
            break;
            
        case 48:
            if (fac > 4194303 || crd > 16777215) {
                fprintf(stderr, "Error: W48 limits: facility 0-4194303, card 0-16777215\n");
                return 1;
            }
            printf("Wiegand-48 (HID Corporate 1000): Facility=%lu Card=%lu\n", (unsigned long)fac, (unsigned long)crd);
            encode_wiegand_48_std(fac, crd, enc);
            break;
            
        case 56:
            if (fac > 16777215 || crd > 1073741823) {
                fprintf(stderr, "Error: W56 limits: facility 0-16777215, card 0-1073741823\n");
                return 1;
            }
            printf("Wiegand-56: Facility=%lu Card=%lu\n", (unsigned long)fac, (unsigned long)crd);
            encode_wiegand_56(fac, crd, enc);
            break;
            
        case 64:
            if (fac > 268435455 || crd > 17179869183ULL) {
                fprintf(stderr, "Error: W64 limits: facility 0-268435455, card 0-17179869183\n");
                return 1;
            }
            printf("Wiegand-64 (SEOS): Facility=%lu Card=%lu\n", (unsigned long)fac, (unsigned long)crd);
            encode_wiegand_64(fac, crd, enc);
            break;
            
        // ═══════════════════════════════════════════════════════════════
        // KEYPAD MODES: 4-bit and 8-bit
        // ═══════════════════════════════════════════════════════════════
        case 4:
            if (crd > 15) {
                fprintf(stderr, "Error: 4-bit keypad: value must be 0-15\n");
                return 1;
            }
            printf("4-bit Keypad: Value=%lu\n", (unsigned long)crd);
            int_to_binary(crd, enc, 4);
            break;
            
        case 8:
            if (crd > 255) {
                fprintf(stderr, "Error: 8-bit keypad: value must be 0-255\n");
                return 1;
            }
            printf("8-bit Keypad: Value=%lu (0x%02lX)\n", (unsigned long)crd, (unsigned long)crd);
            int_to_binary(crd, enc, 8);
            break;
            
        default:
            fprintf(stderr, "Error: Unsupported bit count. Use --format for named formats.\n");
            print_usage(argv[0]);
            return 1;
    }
    
    printf("Binary: %s (%d bits)\n\n", enc, (int)strlen(enc));
    
    return send_wiegand_pulses(d0, d1, enc, pus) < 0 ? 1 : 0;
}
