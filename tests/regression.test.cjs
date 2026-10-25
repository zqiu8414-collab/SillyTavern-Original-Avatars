'use strict';

// Browser-independent contract tests. This small DOM models selector ancestry,
// mutation delivery and capture-before-target event order; it does not model
// network fetches, image decoding, DPR candidate choice, rendering or jQuery.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const helperPath = process.env.ORIGINAL_AVATARS_UNDER_TEST || path.join(__dirname, '..', 'index.js');
const helper = fs.readFileSync(helperPath, 'utf8');
const nativeScriptPath = process.env.ST_PUBLIC_SCRIPT;
// An explicitly supplied native source must exist; otherwise use the fixtures.
const nativeSource = nativeScriptPath ? fs.readFileSync(nativeScriptPath, 'utf8') : null;
const errorFixture = `$(this).hide();\n        $(this).parent().html('<div class="missing-avatar fa-solid fa-user-slash"></div>');`;
const nativeErrorBody = nativeSource
    ? nativeSource.match(/messageElement\.find\('\.avatar img'\)\.on\('error', function \(\) \{([\s\S]*?)\n\s*\}\);/)?.[1]
    : errorFixture;
assert.ok(nativeErrorBody, 'Find the actual native avatar error callback, rather than silently using an obsolete fixture');
const zoomFixture = [
    "const charsPath = '/characters/';",
    "const targetAvatarImg = thumbURL.substring(thumbURL.lastIndexOf('=') + 1);",
    "const avatarSrc = (isDataURL(thumbURL) || /^\\/?img\\/(?:.+)/.test(thumbURL)) ? thumbURL : charsPath + targetAvatarImg;",
].join('\n');
let zoomBody = zoomFixture;
if (nativeSource) {
    const nativeClick = nativeSource.slice(nativeSource.indexOf("$(document).on('click', '.mes .avatar'"));
    zoomBody = ['charsPath', 'targetAvatarImg', 'avatarSrc'].map(name => {
        const match = nativeClick.match(new RegExp(`const ${name} = [^\\r\\n]+`));
        assert.ok(match, `Find actual native click calculation for ${name}`);
        return match[0];
    }).join('\n');
}
const nativeZoomUrl = new Function('thumbURL', 'isDataURL', `${zoomBody}\nreturn avatarSrc;`);

function harness({ theme = '1', readyState = 'complete', savedSettings = {}, hostId = 'extensions_settings2', contextAvailable = true } = {}) {
    let themeValue = theme;
    let saves = 0;
    const extensionSettings = structuredClone(savedSettings);
    const observers = [];
    const frames = [];
    const trace = [];

    function mutation(record) {
        for (const observer of observers) {
            for (const { target, options } of observer.targets) {
                let inScope = target === record.target;
                if (!inScope && options.subtree) {
                    for (let parent = record.target.parentElement; parent; parent = parent.parentElement) {
                        if (parent === target) inScope = true;
                    }
                }
                if (!inScope || !options[record.type]) continue;
                if (record.type === 'attributes' && options.attributeFilter
                    && !options.attributeFilter.includes(record.attributeName)) continue;
                observer.pending.push(record);
                break;
            }
        }
    }

    class Element {
        constructor(tag, attrs = {}) {
            this.tagName = tag.toUpperCase();
            this.attrs = new Map(Object.entries(attrs));
            this.parentElement = null;
            this.children = [];
            this.listeners = [];
            this.hidden = false;
            this.html = '';
            this.selectedSource = undefined;
        }
        get id() { return this.getAttribute('id'); }
        set id(value) { this.setAttribute('id', value); }
        set className(value) { this.setAttribute('class', value); }
        set innerHTML(value) {
            this.html = value;
            // Only native settings controls are parsed; this harness does not render HTML.
            if (value.includes('id="original_avatars_enabled"')) {
                this.append(new Element('input', { id: 'original_avatars_enabled', type: 'checkbox' }));
                this.append(new Element('small', { id: 'original_avatars_status' }));
            }
        }
        dispatchChange() {
            for (const listener of this.listeners.filter(item => item.type === 'change')) listener.callback.call(this, { type: 'change', target: this });
        }
        get isConnected() {
            for (let node = this; node; node = node.parentElement) if (node === document.documentElement) return true;
            return false;
        }
        get currentSrc() {
            if (this.selectedSource !== undefined) return this.selectedSource;
            const chosen = this.getAttribute('srcset')?.split(/\s+/)[0] || this.getAttribute('src');
            return chosen ? new URL(chosen, 'http://127.0.0.1:8000/').href : '';
        }
        getAttribute(name) { return this.attrs.get(name) ?? null; }
        hasAttribute(name) { return this.attrs.has(name); }
        setAttribute(name, value) {
            const oldValue = this.getAttribute(name);
            this.attrs.set(name, String(value));
            mutation({ type: 'attributes', target: this, attributeName: name, oldValue });
        }
        removeAttribute(name) {
            if (!this.hasAttribute(name)) return;
            const oldValue = this.getAttribute(name);
            this.attrs.delete(name);
            mutation({ type: 'attributes', target: this, attributeName: name, oldValue });
        }
        append(...nodes) {
            for (const node of nodes) {
                if (node.parentElement) node.remove();
                node.parentElement = this;
                this.children.push(node);
                mutation({ type: 'childList', target: this, addedNodes: [node], removedNodes: [] });
            }
        }
        remove() {
            const parent = this.parentElement;
            if (!parent) return;
            parent.children.splice(parent.children.indexOf(this), 1);
            this.parentElement = null;
            mutation({ type: 'childList', target: parent, addedNodes: [], removedNodes: [this] });
        }
        matches(selector) {
            return selector.split(',').some(group => {
                // Support child AND descendant combinators so the pre-fix
                // helper can be tested as a genuine negative control too.
                const parts = group.trim().replace(/\s*>\s*/g, '>').split(/(>|\s+)/);
                function matchAt(node, index) {
                    if (!node) return false;
                    const part = parts[index];
                    if (part.startsWith('#') && node.getAttribute('id') !== part.slice(1)) return false;
                    if (part.startsWith('.') && !(node.getAttribute('class') || '').split(/\s+/).includes(part.slice(1))) return false;
                    if (!/^[#.]/.test(part) && node.tagName.toLowerCase() !== part.toLowerCase()) return false;
                    if (index === 0) return true;
                    if (parts[index - 1] === '>') return matchAt(node.parentElement, index - 2);
                    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
                        if (matchAt(parent, index - 2)) return true;
                    }
                    return false;
                }
                return matchAt(this, parts.length - 1);
            });
        }
        querySelectorAll(selector) {
            const result = [];
            for (const child of this.children) {
                if (child.matches(selector)) result.push(child);
                result.push(...child.querySelectorAll(selector));
            }
            return result;
        }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        closest(selector) {
            for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
            return null;
        }
        addEventListener(type, callback, options = false) {
            this.listeners.push({ type, callback, capture: options === true || !!options.capture });
        }
        removeEventListener(type, callback, options = false) {
            const capture = options === true || !!options.capture;
            this.listeners = this.listeners.filter(listener => listener.type !== type || listener.callback !== callback || listener.capture !== capture);
        }
        dispatchError() {
            const event = {
                type: 'error', target: this, stopped: false,
                stopImmediatePropagation() { this.stopped = true; trace.push('stopImmediatePropagation'); },
            };
            // Resource error events do not bubble, but target capture listeners
            // run before target non-capture listeners regardless of registration.
            const ancestors = [];
            for (let node = this.parentElement; node; node = node.parentElement) ancestors.unshift(node);
            for (const node of [...ancestors, this]) {
                for (const listener of node.listeners.filter(item => item.type === 'error' && item.capture)) {
                    listener.callback.call(node, event);
                    if (event.stopped) return event;
                }
            }
            for (const listener of this.listeners.filter(item => item.type === 'error' && !item.capture)) {
                listener.callback.call(this, event);
                if (event.stopped) break;
            }
            return event;
        }
    }

    const document = {
        readyState,
        createElement(tag) { return new Element(tag); },
        documentElement: new Element('html'),
        head: new Element('head'),
        body: new Element('body'),
        listeners: new Map(),
        getElementById(id) {
            return this.documentElement.getAttribute('id') === id ? this.documentElement : this.documentElement.querySelector(`#${id}`);
        },
        addEventListener(type, callback) { this.listeners.set(type, callback); },
    };
    document.documentElement.append(document.head, document.body);
    const chat = new Element('div', { id: 'chat' });
    const style = new Element('style', { id: 'custom-style' });
    document.body.append(chat);
    if (hostId) document.body.append(new Element('div', { id: hostId }));
    document.head.append(style);

    class MutationObserver {
        constructor(callback) { this.callback = callback; this.targets = []; this.pending = []; observers.push(this); }
        observe(target, options) { this.targets.push({ target, options }); }
        disconnect() { this.targets = []; this.pending = []; }
    }
    const context = vm.createContext({
        document, Element, MutationObserver, URL,
        SillyTavern: contextAvailable ? { getContext() { return { extensionSettings, saveSettingsDebounced() { saves++; } }; } } : undefined,
        location: { href: 'http://127.0.0.1:8000/', origin: 'http://127.0.0.1:8000' },
        getComputedStyle() { return { getPropertyValue(name) { return name === '--paris-hd-portraits' ? themeValue : ''; } }; },
        requestAnimationFrame(callback) { frames.push(callback); },
    });
    function settle() {
        for (let iteration = 0; iteration < 30; iteration++) {
            let worked = false;
            for (const observer of observers) {
                if (!observer.pending.length) continue;
                const pending = observer.pending.splice(0);
                observer.callback(pending);
                worked = true;
            }
            if (frames.length) {
                for (const frame of frames.splice(0)) frame();
                worked = true;
            }
            if (!worked) return;
        }
        assert.fail('Mutation/animation-frame queue did not settle');
    }
    function makeAvatar(source, { srcset, native = true, container = chat } = {}) {
        const message = new Element('div', { class: 'mes' });
        const wrapper = new Element('div', { class: 'mesAvatarWrapper' });
        const avatar = new Element('div', { class: 'avatar' });
        const img = new Element('img', { src: source, ...(srcset === undefined ? {} : { srcset }) });
        avatar.append(img); wrapper.append(avatar); message.append(wrapper); container.append(message);
        if (native) attachNativeError(img);
        return { message, wrapper, avatar, img };
    }
    function attachNativeError(img) {
        const nativeCallback = new Function('$', `return function () { ${nativeErrorBody} };`)(element => ({
            hide() { trace.push('native:hide'); element.hidden = true; return this; },
            parent() {
                const parent = element.parentElement;
                return { html(value) { trace.push('native:missing-avatar'); parent.html = value; for (const child of [...parent.children]) child.remove(); } };
            },
        }));
        img.addEventListener('error', nativeCallback);
    }
    return {
        document, chat, style, Element, trace, makeAvatar, settle, extensionSettings,
        get saves() { return saves; },
        toggle(value) { const checkbox = document.getElementById('original_avatars_enabled'); assert.ok(checkbox, 'settings checkbox exists'); checkbox.checked = value; checkbox.dispatchChange(); settle(); },
        get checkbox() { return document.getElementById('original_avatars_enabled'); },
        load() { vm.runInContext(helper, context, { filename: 'portrait-helper.js' }); settle(); },
        activate() { document.readyState = 'complete'; document.listeners.get('DOMContentLoaded')?.(); settle(); },
        setTheme(value) { themeValue = value; document.documentElement.setAttribute('style', `--paris-hd-portraits:${value}`); settle(); },
    };
}

test('native contracts come from installed ST when present; fixture fallback is explicit', () => {
    assert.match(nativeErrorBody, /\$\(this\)\.hide\(\)/);
    assert.match(nativeErrorBody, /missing-avatar fa-solid fa-user-slash/);
    assert.match(zoomBody, /lastIndexOf\('='.*/);
    assert.equal(nativeZoomUrl('/thumbnail?type=avatar&file=Jane%20Doe.png', () => false), '/characters/Jane%20Doe.png');
});

test('HD uses owned srcset while actual native character zoom input remains unchanged', () => {
    const h = harness();
    const source = '/thumbnail?type=avatar&file=Jane%20Doe.png';
    const { img } = h.makeAvatar(source);
    h.load();
    assert.equal(img.getAttribute('src'), source);
    assert.equal(img.getAttribute('srcset'), 'http://127.0.0.1:8000/characters/Jane%20Doe.png 1x');
    assert.equal(nativeZoomUrl(img.getAttribute('src'), () => false), '/characters/Jane%20Doe.png');
    assert.equal(img.currentSrc, 'http://127.0.0.1:8000/characters/Jane%20Doe.png');
});

test('capture intercepts first HD failure before earlier native error callback; thumbnail failure still reaches native', () => {
    const h = harness();
    const { img, avatar } = h.makeAvatar('/thumbnail?type=avatar&file=Raymond.png');
    h.load();
    const hdError = img.dispatchError();
    h.settle();
    assert.equal(hdError.stopped, true);
    assert.equal(img.isConnected, true);
    assert.equal(img.hidden, false);
    assert.equal(img.hasAttribute('srcset'), false);
    assert.deepEqual(h.trace, ['stopImmediatePropagation']);
    img.dispatchError();
    h.settle();
    assert.equal(img.isConnected, false);
    assert.match(avatar.html, /missing-avatar/);
    assert.deepEqual(h.trace, ['stopImmediatePropagation', 'native:hide', 'native:missing-avatar']);
});

test('thumbnail/currentSrc failure is never swallowed while an HD candidate exists', () => {
    const h = harness();
    const { img } = h.makeAvatar('/thumbnail?type=avatar&file=Raymond.png');
    h.load();
    img.selectedSource = 'http://127.0.0.1:8000/thumbnail?type=avatar&file=Raymond.png';
    assert.equal(img.dispatchError().stopped, false);
    h.settle();
    assert.equal(img.isConnected, false);
    assert.deepEqual(h.trace, ['native:hide', 'native:missing-avatar']);
});

test('a pending/empty currentSrc HD failure can safely retry its unchanged thumbnail', () => {
    const h = harness();
    const { img } = h.makeAvatar('/thumbnail?type=avatar&file=Raymond.png');
    h.load();
    img.selectedSource = '';
    assert.equal(img.dispatchError().stopped, true);
    h.settle();
    assert.equal(img.hasAttribute('srcset'), false);
    assert.equal(img.isConnected, true);
});

test('native persona switch wins and recomputes original URL including cache key', () => {
    const h = harness();
    const { img } = h.makeAvatar('/thumbnail?type=persona&file=Before.png');
    h.load();
    img.setAttribute('src', '/thumbnail?type=persona&file=After%20Rain.png&t=246');
    h.settle();
    assert.equal(img.getAttribute('src'), '/thumbnail?type=persona&file=After%20Rain.png&t=246');
    assert.equal(img.getAttribute('srcset'), 'http://127.0.0.1:8000/User%20Avatars/After%20Rain.png?t=246 1x');
    img.setAttribute('src', '/img/default-user.png');
    h.settle();
    assert.equal(img.hasAttribute('srcset'), false);
    assert.equal(img.getAttribute('src'), '/img/default-user.png');
});

test('same failed thumbnail is not retried until extension toggles; a new avatar can retry', () => {
    const h = harness();
    const { img } = h.makeAvatar('/thumbnail?type=avatar&file=First.png');
    h.load(); img.dispatchError(); h.settle();
    img.setAttribute('src', '/thumbnail?type=avatar&file=First.png'); h.settle();
    assert.equal(img.hasAttribute('srcset'), false);
    img.setAttribute('src', '/thumbnail?type=avatar&file=Second.png'); h.settle();
    assert.match(img.getAttribute('srcset'), /Second\.png 1x$/);
    img.dispatchError(); h.settle();
    h.toggle(false); h.toggle(true);
    assert.match(img.getAttribute('srcset'), /Second\.png 1x$/);
});

test('switch off releases owned srcset/error handler and keeps native src exactly intact', () => {
    const h = harness();
    const source = '/thumbnail?type=avatar&file=Raymond.png';
    const { img } = h.makeAvatar(source);
    h.load(); h.toggle(false);
    assert.equal(img.getAttribute('src'), source);
    assert.equal(img.hasAttribute('srcset'), false);
    assert.equal(img.listeners.filter(listener => listener.type === 'error' && listener.capture).length, 0);
    assert.equal(img.dispatchError().stopped, false);
    assert.deepEqual(h.trace, ['native:hide', 'native:missing-avatar']);
});

test('foreign srcset is never replaced, including a takeover after helper enablement', () => {
    const h = harness();
    const initial = h.makeAvatar('/thumbnail?type=avatar&file=A.png', { srcset: '/foreign/a.png 2x' }).img;
    const takeover = h.makeAvatar('/thumbnail?type=avatar&file=B.png').img;
    h.load();
    assert.equal(initial.getAttribute('srcset'), '/foreign/a.png 2x');
    takeover.setAttribute('srcset', '/foreign/b.png 2x'); h.settle();
    h.toggle(false);
    assert.equal(takeover.getAttribute('srcset'), '/foreign/b.png 2x');
    assert.equal(takeover.listeners.filter(listener => listener.capture).length, 0);
});

test('foreign srcset takeover before observer delivery never has its error intercepted', () => {
    const h = harness();
    const { img } = h.makeAvatar('/thumbnail?type=avatar&file=A.png');
    h.load();
    img.setAttribute('srcset', '/foreign/not-owned.png 1x');
    assert.equal(img.dispatchError().stopped, false);
    h.settle();
    assert.equal(img.getAttribute('srcset'), '/foreign/not-owned.png 1x');
    assert.deepEqual(h.trace, ['native:hide', 'native:missing-avatar']);
});

test('strict native ancestry excludes custom cards, pictures, external images and unrelated UI', () => {
    const h = harness();
    const external = h.makeAvatar('https://example.invalid/thumbnail?type=avatar&file=A.png').img;
    const ordinary = h.makeAvatar('/characters/A.png').img;
    const badFile = h.makeAvatar('/thumbnail?type=avatar&file=..%2Fsecret.png').img;
    const badType = h.makeAvatar('/thumbnail?type=bg&file=A.png').img;
    const unrelated = h.makeAvatar('/thumbnail?type=avatar&file=A.png', { container: h.document.body }).img;
    const custom = h.makeAvatar('/thumbnail?type=avatar&file=A.png');
    const card = new h.Element('div', { class: 'mes_text' });
    custom.message.append(card); card.append(custom.wrapper);
    const pictureItem = h.makeAvatar('/thumbnail?type=avatar&file=A.png');
    const picture = new h.Element('picture');
    pictureItem.avatar.append(picture); picture.append(pictureItem.img);
    h.load();
    for (const img of [external, ordinary, badFile, badType, unrelated, custom.img, pictureItem.img]) {
        assert.equal(img.hasAttribute('srcset'), false);
        assert.equal(img.listeners.filter(listener => listener.capture).length, 0);
    }
});

test('dynamically inserted native messages are enhanced; moved-out or detached images release owned changes', () => {
    const h = harness(); h.load();
    const first = h.makeAvatar('/thumbnail?type=avatar&file=A.png'); h.settle();
    assert.match(first.img.getAttribute('srcset'), /\/characters\/A.png 1x$/);
    const text = new h.Element('div', { class: 'mes_text' });
    first.message.append(text); text.append(first.img); h.settle();
    assert.equal(first.img.hasAttribute('srcset'), false);
    assert.equal(first.img.isConnected, true);
    const second = h.makeAvatar('/thumbnail?type=persona&file=B.png'); h.settle();
    second.message.remove(); h.settle();
    assert.equal(second.img.hasAttribute('srcset'), false);
    assert.equal(second.img.listeners.filter(listener => listener.capture).length, 0);
});

test('saved disabled preference survives initialization and enabling saves it', () => {
    const h = harness({ theme: '0', readyState: 'loading', savedSettings: { original_avatars: { enabled: false } } });
    const { img } = h.makeAvatar('/thumbnail?type=avatar&file=A.png');
    h.load();
    assert.equal(img.hasAttribute('srcset'), false);
    assert.equal(h.checkbox, null);
    h.activate();
    assert.equal(h.checkbox.checked, false);
    assert.equal(img.hasAttribute('srcset'), false);
    assert.equal(h.saves, 0);
    h.toggle(true);
    assert.equal(h.extensionSettings.original_avatars.enabled, true);
    assert.equal(h.saves, 1);
    assert.match(img.getAttribute('srcset'), /characters\/A.png 1x$/);
});

test('new install defaults to enabled without a theme marker and theme changes do not override switch', () => {
    const h = harness({ theme: '' });
    const { img } = h.makeAvatar('/thumbnail?type=avatar&file=A.png');
    h.load();
    assert.equal(h.extensionSettings.original_avatars.enabled, true);
    assert.equal(h.checkbox.checked, true);
    assert.ok(img.hasAttribute('srcset'));
    h.setTheme('0');
    assert.ok(img.hasAttribute('srcset'));
    h.toggle(false);
    h.setTheme('1');
    assert.equal(img.hasAttribute('srcset'), false);
});

test('both switch transitions persist and a new session restores the saved preference', () => {
    const h = harness();
    h.makeAvatar('/thumbnail?type=persona&file=A.png');
    h.load(); h.toggle(false);
    assert.equal(h.saves, 1);
    assert.equal(h.extensionSettings.original_avatars.enabled, false);
    const next = harness({ savedSettings: JSON.parse(JSON.stringify(h.extensionSettings)) });
    const { img } = next.makeAvatar('/thumbnail?type=persona&file=A.png');
    next.load();
    assert.equal(next.checkbox.checked, false);
    assert.equal(img.hasAttribute('srcset'), false);
    next.toggle(true);
    assert.equal(next.saves, 1);
    assert.equal(next.extensionSettings.original_avatars.enabled, true);
    assert.match(img.getAttribute('srcset'), /User%20Avatars\/A.png 1x$/);
});

test('repeated script initialization installs only one control and one handler', () => {
    const h = harness();
    const { img } = h.makeAvatar('/thumbnail?type=avatar&file=A.png');
    h.load(); h.load();
    assert.equal(h.document.documentElement.querySelectorAll('#original_avatars_settings').length, 1);
    assert.equal(h.checkbox.listeners.filter(item => item.type === 'change').length, 1);
    assert.equal(img.listeners.filter(item => item.type === 'error' && item.capture).length, 1);
    h.toggle(false);
    assert.equal(h.saves, 1);
    assert.equal(img.hasAttribute('srcset'), false);
});

test('settings fallback host is supported; missing native API or host leaves avatars untouched', () => {
    const fallback = harness({ hostId: 'extensions_settings' });
    fallback.load();
    assert.ok(fallback.checkbox);
    for (const options of [{ hostId: null }, { contextAvailable: false }]) {
        const h = harness(options);
        const { img } = h.makeAvatar('/thumbnail?type=avatar&file=A.png');
        h.load();
        assert.equal(img.hasAttribute('srcset'), false);
        assert.equal(h.checkbox, null);
        assert.equal(h.saves, 0);
    }
});

test('malformed preference defaults safely while unrelated settings remain unchanged', () => {
    for (const malformed of [null, 'yes', [], { enabled: 'false' }]) {
        const h = harness({ savedSettings: { original_avatars: malformed, other_extension: { enabled: false, custom: 7 } } });
        h.load();
        assert.equal(h.checkbox.checked, true);
        assert.deepEqual(h.extensionSettings.other_extension, { enabled: false, custom: 7 });
    }
});

test('switch off before queued enhancement flush leaves all native avatars unchanged', () => {
    const h = harness();
    h.load();
    const { img } = h.makeAvatar('/thumbnail?type=avatar&file=A.png');
    h.checkbox.checked = false;
    h.checkbox.dispatchChange();
    h.settle();
    assert.equal(img.hasAttribute('srcset'), false);
    assert.equal(img.getAttribute('src'), '/thumbnail?type=avatar&file=A.png');
});
