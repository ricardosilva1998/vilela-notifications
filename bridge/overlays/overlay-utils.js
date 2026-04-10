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

    // CSS scale — shrinks/grows everything uniformly (text, rows, columns)
    // Keeps exact layout and aspect ratio, just renders smaller/larger
    var panel = document.querySelector('.overlay-panel');

    // Apply saved scale from settings
    var currentScale = 100;
    try {
      if (overlayId && fs.existsSync(settingsFile)) {
        var allSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        var s = (allSettings.overlayCustom && allSettings.overlayCustom[overlayId]) || {};
        if (s.scale) currentScale = parseInt(s.scale) || 100;
      }
    } catch(e) {}

    // Sync window size to panel content (called on scale change and content resize)
    var _lastW = 0, _lastH = 0;
    function syncWindowSize() {
      if (!panel || currentScale === 100) return;
      var factor = currentScale / 100;
      var w = panel.scrollWidth;
      var h = panel.scrollHeight;
      var newW = Math.round(w * factor) + 4;
      var newH = Math.round(h * factor) + 4;
      if (newW !== _lastW || newH !== _lastH) {
        _lastW = newW; _lastH = newH;
        try { ipcRenderer.send('resize-overlay-wh', newW, newH); } catch(e2) {}
      }
    }

    // Apply CSS scale — controlled via settings panel Scale dropdown
    function applyScale(pct) {
      currentScale = pct;
      if (panel) {
        if (pct === 100) {
          panel.style.transform = '';
          panel.style.transformOrigin = '';
          panel.style.overflow = '';
          return;
        }
        var factor = pct / 100;
        // Don't lock width/height — let panel grow with content
        panel.style.overflow = 'visible';
        panel.style.transform = 'scale(' + factor + ')';
        panel.style.transformOrigin = 'top left';
        syncWindowSize();
      }
    }

    // Expose current scale for overlays that do their own height resizing
    window.__overlayScale = function() { return currentScale / 100; };

    if (currentScale !== 100) {
      applyScale(currentScale);
      // Re-sync window when content changes (data arrives, rows added, etc.)
      if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(syncWindowSize).observe(panel);
      } else {
        setInterval(syncWindowSize, 500);
      }
    }

  } catch(e) {}
})();
