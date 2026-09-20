# Makefile for wiegand_tx
# Usage: make

CC = gcc
CFLAGS = -Wall -Wextra -O2 -D_GNU_SOURCE
LDFLAGS = -lgpiod

# Directories
SRC_DIR = .
BIN_DIR = ../bin

# Target
TARGET = $(BIN_DIR)/wiegand_tx
SOURCE = $(SRC_DIR)/wiegand_tx.c

# Default target
all: $(TARGET)

# Create bin directory if it doesn't exist
$(BIN_DIR):
	@mkdir -p $(BIN_DIR)

# Compile wiegand_tx
$(TARGET): $(SOURCE) | $(BIN_DIR)
	@echo "Compiling wiegand_tx..."
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)
	@echo "✓ Built: $@"
	@echo "✓ Ready to use!"

# Clean build artifacts
clean:
	@rm -f $(TARGET)
	@echo "✓ Cleaned build artifacts"

# Install dependencies (Debian/Ubuntu)
install-deps:
	@echo "Installing libgpiod development files..."
	sudo apt-get update
	sudo apt-get install -y libgpiod-dev gpiod
	@echo "✓ Dependencies installed"

# Test binary exists
test:
	@if [ -f $(TARGET) ]; then \
		echo "✓ Binary exists: $(TARGET)"; \
		$(TARGET) --help 2>&1 || echo "Binary compiled successfully"; \
	else \
		echo "✗ Binary not found. Run 'make' to compile."; \
		exit 1; \
	fi

.PHONY: all clean install-deps test
