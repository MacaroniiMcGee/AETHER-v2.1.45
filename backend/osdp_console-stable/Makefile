SHELL := bash
.ONESHELL:
.SHELLFLAGS := -eu -o pipefail -c
.DELETE_ON_ERROR:
MAKEFLAGS += --warn-undefined-variables
MAKEFLAGS += --no-builtin-rules

ifeq ($(origin .RECIPEPREFIX), undefined)
  $(error This Make does not support .RECIPEPREFIX. Please use GNU Make 4.0 or later)
endif
.RECIPEPREFIX = >

DIST := dist/
HASH := $(shell git rev-parse --short HEAD)
RELEASE_PREFIX := osdp-console-

$(DIST): console.py osdplib/
> mkdir -p $(DIST)
> cp console.py $(DIST)
> cp -r osdplib/ $(DIST)/osdplib
> rm -rf $(DIST)/osdplib/__pycache__
> cp requirements.txt $(DIST)
> cp README.md $(DIST)

$(RELEASE_PREFIX)$(HASH).tar.gz: $(DIST)
> tar -cvf $(RELEASE_PREFIX)$(HASH).tar.gz $(DIST)

clean:
> rm -rf $(DIST) || true
> rm -rf $(RELEASE_PREFIX)*
.PHONY: clean

release: $(RELEASE_PREFIX)$(HASH).tar.gz
> echo "create release for $(HASH)"
.PHONY: release
