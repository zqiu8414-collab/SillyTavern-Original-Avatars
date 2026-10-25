/* Original Avatars: same-origin originals, native thumbnail src preserved. */
(() => {
    'use strict';
    const selector = '#chat > .mes > .mesAvatarWrapper > .avatar > img';
    const settingsKey = 'original_avatars';
    const records = new Map();
    let failed = new WeakMap();
    let enabled = false;
    let queued = false;
    const pending = new Set();

    function originalUrl(source) {
        try {
            const thumbnail = new URL(source, location.href);
            const type = thumbnail.searchParams.get('type');
            const file = thumbnail.searchParams.get('file');
            if (thumbnail.origin !== location.origin || thumbnail.pathname !== '/thumbnail'
                || !['avatar', 'persona'].includes(type) || !file
                || /[\\/\u0000]/.test(file) || file === '.' || file === '..') return null;
            const route = type === 'avatar' ? '/characters/' : '/User%20Avatars/';
            const full = new URL(route + encodeURIComponent(file), location.origin);
            if (thumbnail.searchParams.has('t')) full.searchParams.set('t', thumbnail.searchParams.get('t'));
            return full.href;
        } catch {
            return null;
        }
    }

    function release(img) {
        const record = records.get(img);
        if (!record) return;
        img.removeEventListener('error', record.onError, true);
        records.delete(img);
        // Never overwrite a srcset supplied by the native UI or another extension.
        if (img.getAttribute('srcset') === record.srcset) img.removeAttribute('srcset');
    }

    function sync(img) {
        const source = img.getAttribute('src');
        const record = records.get(img);
        if (record && source === record.thumbnail && img.getAttribute('srcset') === record.srcset
            && img.matches(selector)) return;
        release(img); // A native persona/avatar switch wins over our old URL.
        if (!enabled || !img.matches(selector) || !source || failed.get(img) === source) return;
        // Leave existing responsive-image ownership alone. Native ST avatars have
        // no srcset; picture sources could override an img's srcset selection.
        if (img.hasAttribute('srcset') || img.closest('picture')) return;
        const full = originalUrl(source);
        if (!full) return;
        const next = { thumbnail: source, full, srcset: `${full} 1x`, onError: null };
        next.onError = event => {
            if (records.get(img) !== next || img.getAttribute('src') !== source
                || img.getAttribute('srcset') !== next.srcset
                || (img.currentSrc && img.currentSrc !== full)) return;
            // ST's earlier target/bubble error listener removes the img. Capture
            // runs first, so only our failed original request is intercepted.
            // A subsequent thumbnail failure reaches ST's native handler.
            event.stopImmediatePropagation();
            failed.set(img, source);
            release(img);
        };
        records.set(img, next);
        img.addEventListener('error', next.onError, true);
        // ST's avatar-click code parses src as a thumbnail query. srcset selects
        // the original pixels while leaving that native click input untouched.
        img.setAttribute('srcset', next.srcset);
    }

    function flush() {
        queued = false;
        for (const img of records.keys()) if (!img.isConnected || !img.matches(selector)) release(img);
        for (const img of pending) if (img.isConnected) sync(img);
        pending.clear();
    }

    function enqueue(root) {
        if (!(root instanceof Element)) return;
        const images = root.querySelectorAll(selector);
        const isAvatar = root.matches(selector);
        if (isAvatar) pending.add(root);
        for (const img of images) pending.add(img);
        if (isAvatar || images.length) schedule();
    }

    function schedule() {
        if (!queued && (pending.size || records.size)) {
            queued = true;
            requestAnimationFrame(flush);
        }
    }

    function setEnabled(next) {
        if (next === enabled) return;
        enabled = next;
        if (enabled) {
            failed = new WeakMap();
            enqueue(document.getElementById('chat'));
        } else {
            pending.clear();
            for (const img of records.keys()) release(img);
        }
    }

    function start() {
        const chat = document.getElementById('chat');
        const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
        const context = globalThis.SillyTavern?.getContext?.();
        // Fail without taking ownership when the native settings API is absent.
        if (!chat || !host || !context?.extensionSettings || !context.saveSettingsDebounced) return;
        if (document.getElementById('original_avatars_settings')) return;

        let settings = context.extensionSettings[settingsKey];
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
            settings = context.extensionSettings[settingsKey] = {};
        }
        if (typeof settings.enabled !== 'boolean') settings.enabled = true;

        const panel = document.createElement('div');
        panel.id = 'original_avatars_settings';
        panel.className = 'extension_container';
        panel.innerHTML = `
            <details class="original-avatars-panel">
                <summary><b>原图头像 · Original Avatars</b></summary>
                <div class="original-avatars-content">
                    <label class="checkbox_label" for="original_avatars_enabled">
                        <input id="original_avatars_enabled" type="checkbox" aria-describedby="original_avatars_help">
                        <span>启用原图头像</span>
                    </label>
                    <small id="original_avatars_help">使用角色和用户头像的原始图片，适用于任何主题。关闭后立即恢复缩略图。</small>
                    <small class="original-avatars-note">仅从当前酒馆加载；原图体积较大，会增加图片流量。</small>
                    <small id="original_avatars_status" role="status" aria-live="polite"></small>
                </div>
            </details>`;
        host.append(panel);
        const checkbox = panel.querySelector('#original_avatars_enabled');
        const status = panel.querySelector('#original_avatars_status');
        const render = () => {
            checkbox.checked = settings.enabled;
            status.textContent = settings.enabled ? '已启用 · 读取原图' : '已关闭 · 使用缩略图';
            setEnabled(settings.enabled);
        };
        checkbox.addEventListener('change', () => {
            settings.enabled = checkbox.checked;
            render();
            context.saveSettingsDebounced();
        });
        new MutationObserver(mutations => {
            if (!enabled) return;
            for (const mutation of mutations) {
                if (mutation.type === 'attributes') enqueue(mutation.target);
                else {
                    for (const node of mutation.addedNodes) enqueue(node);
                    // Prune removed messages without inspecting their text.
                    for (const node of mutation.removedNodes) {
                        if (node instanceof Element && (node.matches('.mes,.mesAvatarWrapper,.avatar,img')
                            || node.querySelector('.mesAvatarWrapper'))) schedule();
                    }
                }
            }
        }).observe(chat, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset'] });

        render();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
})();
