# clode — POSIX Makefile. Portable across GNU make and BSD make (bmake).
# Override on the command line: PREFIX, DESTDIR, BINDIR, LIBEXECDIR, MANDIR,
# DOCDIR, NODE, PYTHON, CLAUDE_BIN.

PREFIX     ?= /usr/local
BINDIR     ?= $(PREFIX)/bin
LIBEXECDIR ?= $(PREFIX)/libexec
MANDIR     ?= $(PREFIX)/share/man
DOCDIR     ?= $(PREFIX)/share/doc
DESTDIR    ?=
NODE       ?= node
PYTHON     ?= python3
CLAUDE_BIN ?=

pkglibexec = $(LIBEXECDIR)/clode

all:
	@echo "Nothing to build. Run: make install [PREFIX=... DESTDIR=... CLAUDE_BIN=...]"

install:
	@v=`cat VERSION`; \
	node=`command -v $(NODE) 2>/dev/null || echo $(NODE)`; \
	python=`command -v $(PYTHON) 2>/dev/null || echo $(PYTHON)`; \
	mkdir -p "$(DESTDIR)$(BINDIR)" "$(DESTDIR)$(pkglibexec)" \
	         "$(DESTDIR)$(MANDIR)/man1" "$(DESTDIR)$(DOCDIR)/clode"; \
	sed -e "s|@VERSION@|$$v|g" \
	    -e "s|@LIBEXEC@|$(pkglibexec)|g" \
	    -e "s|@NODE@|$$node|g" \
	    -e "s|@PYTHON@|$$python|g" \
	    -e "s|@CLAUDE_BIN@|$(CLAUDE_BIN)|g" \
	    bin/clode > "$(DESTDIR)$(BINDIR)/clode"; \
	chmod 0755 "$(DESTDIR)$(BINDIR)/clode"; \
	cp libexec/extract-claude-js libexec/inspect-claude-bundle libexec/bun-shim.cjs "$(DESTDIR)$(pkglibexec)/"; \
	cp man/clode.1 "$(DESTDIR)$(MANDIR)/man1/clode.1"; \
	cp README.md LICENSE "$(DESTDIR)$(DOCDIR)/clode/"; \
	echo "installed clode $$v to $(DESTDIR)$(BINDIR)/clode"

uninstall:
	rm -f "$(DESTDIR)$(BINDIR)/clode" \
	      "$(DESTDIR)$(pkglibexec)/extract-claude-js" \
	      "$(DESTDIR)$(pkglibexec)/inspect-claude-bundle" \
	      "$(DESTDIR)$(pkglibexec)/bun-shim.cjs" \
	      "$(DESTDIR)$(MANDIR)/man1/clode.1" \
	      "$(DESTDIR)$(DOCDIR)/clode/README.md" \
	      "$(DESTDIR)$(DOCDIR)/clode/LICENSE"
	-rmdir "$(DESTDIR)$(pkglibexec)" "$(DESTDIR)$(DOCDIR)/clode" 2>/dev/null || true

dist:
	@v=`cat VERSION`; \
	git archive --prefix=clode-$$v/ -o clode-$$v.tar.gz HEAD; \
	echo "wrote clode-$$v.tar.gz"

clean:
	rm -f clode-*.tar.gz

test check:
	sh test/run-all.sh

test-online:
	sh test/run-all.sh --online

.PHONY: all install uninstall dist clean test check test-online
