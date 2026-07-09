CC = gcc
CFLAGS = -O2 -Wall -Wextra -Wno-unused-parameter \
    $(shell pkg-config --cflags freerdp-client2 freerdp2 winpr2)
LDFLAGS = $(shell pkg-config --libs freerdp-client2 freerdp2 winpr2) \
    -lpthread

TARGET = zephyr-rdp-bridge

$(TARGET): zephyr-rdp-bridge.c
	$(CC) $(CFLAGS) -o $(TARGET) zephyr-rdp-bridge.c $(LDFLAGS)

clean:
	rm -f $(TARGET)

.PHONY: clean
