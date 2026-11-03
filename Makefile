UUID := viseur@mumpkin
ZIP  := dist/$(UUID).shell-extension.zip

.PHONY: test install uninstall zip clean

test:
	node --test tests/*.test.mjs

install:
	./scripts/install.sh

uninstall:
	./scripts/uninstall.sh

# Bundle to upload to extensions.gnome.org (no compiled schema: not needed for GNOME 45+).
zip: test
	rm -f extension/schemas/gschemas.compiled
	mkdir -p dist
	gnome-extensions pack extension --force --out-dir dist \
		--schema=schemas/org.gnome.shell.extensions.viseur.gschema.xml \
		--extra-source=model.js \
		--extra-source=renderer.js \
		--extra-source=profiles.js \
		--extra-source=icons
	@echo "→ $(ZIP)"

clean:
	rm -rf dist extension/schemas/gschemas.compiled
