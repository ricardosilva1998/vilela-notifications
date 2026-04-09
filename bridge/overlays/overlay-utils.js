// Shared overlay utilities — header toggle + drag support
// Include via: <script src="overlay-utils.js"></script> at the end of each overlay

(function() {
  'use strict';

  // Load overlay settings
  var overlayId = '';
  var showHeader = true;

  try {
    var fs = require('fs');
    var path = require('path');
    var os = require('os');
    var settingsFile = path.join(os.homedir(), 'Documents', 'Atleta Bridge', 'settings.json');
    if (fs.existsSync(settingsFile)) {
      var all = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      // Detect overlay ID from the page title or URL
      var pagePath = window.location.pathname || '';
      var match = pagePath.match(/overlays\/(\w+)\.html/);
      if (match) overlayId = match[1];
      if (overlayId && all.overlayCustom && all.overlayCustom[overlayId]) {
        var s = all.overlayCustom[overlayId];
        if (s.showHeader === false) showHeader = false;
      }
    }
  } catch(e) {}

  // Apply header visibility
  var header = document.querySelector('.overlay-header');
  if (header && !showHeader) {
    header.style.display = 'none';
    // Make entire panel draggable when header is hidden
    var panel = document.querySelector('.overlay-panel');
    if (panel) {
      panel.style.cursor = 'move';
      panel.classList.add('no-header-drag');
    }
  }

  // Enhanced drag support — works with or without header
  try {
    var ipcRenderer = require('electron').ipcRenderer;
    var _dragging = false;
    var _dragStartX = 0, _dragStartY = 0;

    var dragTarget = (!showHeader && document.querySelector('.overlay-panel'))
      ? document.querySelector('.overlay-panel')
      : document.querySelector('.overlay-header');

    if (dragTarget) {
      dragTarget.style.cursor = 'move';
      dragTarget.addEventListener('mousedown', function(e) {
        // Don't drag from buttons, toggles, selects
        if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT' ||
            e.target.tagName === 'INPUT' || e.target.closest('.toggle-btn') ||
            e.target.closest('.tab-btn') || e.target.closest('.lap-tab')) return;
        if (e.button !== 0) return;
        _dragging = true;
        _dragStartX = e.screenX;
        _dragStartY = e.screenY;
        e.preventDefault();
      });
    }

    document.addEventListener('mousemove', function(e) {
      if (!_dragging) return;
      var dx = e.screenX - _dragStartX;
      var dy = e.screenY - _dragStartY;
      _dragStartX = e.screenX;
      _dragStartY = e.screenY;
      ipcRenderer.send('drag-overlay', dx, dy);
    });
    document.addEventListener('mouseup', function() { _dragging = false; });
    document.addEventListener('mouseleave', function() { _dragging = false; });

    // Click-through: transparent areas pass through, visible panel captures
    var _mouseOverPanel = false;
    document.addEventListener('mousemove', function(e) {
      if (_dragging) return;
      var panel = document.querySelector('.overlay-panel');
      if (!panel) return;
      var r = panel.getBoundingClientRect();
      var over = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (over && !_mouseOverPanel) {
        _mouseOverPanel = true;
        ipcRenderer.send('set-ignore-mouse', false);
      } else if (!over && _mouseOverPanel) {
        _mouseOverPanel = false;
        ipcRenderer.send('set-ignore-mouse', true);
      }
    });
    document.addEventListener('mouseleave', function() {
      if (_dragging) return;
      if (_mouseOverPanel) {
        _mouseOverPanel = false;
        ipcRenderer.send('set-ignore-mouse', true);
      }
    });

    // Save state before reload
    ipcRenderer.on('will-reload', function() {
      if (typeof window.__getState === 'function') {
        try {
          sessionStorage.setItem('_overlayState', JSON.stringify(window.__getState()));
        } catch(e) {}
      }
    });

    // Expose drag state for other scripts
    window.__isDragging = function() { return _dragging; };

    // Resize grip — visible handle in bottom-right corner
    var grip = document.createElement('div');
    grip.style.cssText = 'position:fixed;bottom:0;right:0;width:14px;height:14px;cursor:nwse-resize;z-index:9999;opacity:0.3;transition:opacity 0.15s;';
    grip.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M12 2L2 12M12 6L6 12M12 10L10 12" stroke="rgba(255,255,255,0.6)" stroke-width="1.5" stroke-linecap="round"/></svg>';
    grip.addEventListener('mouseenter', function() { grip.style.opacity = '0.8'; });
    grip.addEventListener('mouseleave', function() { if (!_resizing) grip.style.opacity = '0.3'; });
    document.body.appendChild(grip);

    var _resizing = false, _resizeStartX = 0, _resizeStartY = 0, _startW = 0, _startH = 0, _aspectRatio = 1;
    grip.addEventListener('mousedown', function(e) {
      if (e.button !== 0) return;
      _resizing = true;
      _resizeStartX = e.screenX;
      _resizeStartY = e.screenY;
      try {
        var size = ipcRenderer.sendSync('get-window-size');
        if (size) { _startW = size[0]; _startH = size[1]; _aspectRatio = _startW / _startH; }
      } catch(e2) { _startW = window.outerWidth; _startH = window.outerHeight; _aspectRatio = _startW / _startH; }
      e.preventDefault();
      e.stopPropagation();
    });
    document.addEventListener('mousemove', function(e) {
      if (!_resizing) return;
      var dx = e.screenX - _resizeStartX;
      var newW = Math.max(150, _startW + dx);
      var newH = Math.max(80, Math.round(newW / _aspectRatio));
      ipcRenderer.send('resize-overlay-wh', newW, newH);
    });
    document.addEventListener('mouseup', function() {
      if (_resizing) { _resizing = false; grip.style.opacity = '0.3'; }
    });

  } catch(e) {}
})();
