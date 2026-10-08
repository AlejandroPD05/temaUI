const darkGreenThemeCSS = `
:root {
  --player-bg: #070A08;
  --player-surface: #0E1512;
  --player-border: #1E2B24;
  --player-text: #E7F0EA;
  --player-muted: #7C9186;
  --player-accent: #2FBE73;
  --player-accent-soft: rgba(47, 190, 115, 0.16);
  --video-canvas: #04120A;
}

.theme-toggle {
  background: var(--player-accent);
  color: #04120A;
}

.play-overlay {
  background: rgba(47, 190, 115, 0.22);
}

.play-overlay:hover {
  background: rgba(47, 190, 115, 0.34);
}
`;

const themeToggle = document.getElementById('themeToggle');
let injectedStyleTag = null;

const applyDarkGreenTheme = () => {
  injectedStyleTag = document.createElement('style');
  injectedStyleTag.id = 'injected-dark-green-theme';
  injectedStyleTag.textContent = darkGreenThemeCSS;
  document.head.appendChild(injectedStyleTag);
  document.body.classList.add('theme-dark-green');
  themeToggle.textContent = 'Quitar tema';
};

const removeDarkGreenTheme = () => {
  if (injectedStyleTag) {
    injectedStyleTag.remove();
    injectedStyleTag = null;
  }
  document.body.classList.remove('theme-dark-green');
  themeToggle.textContent = 'Aplicar tema Verde Oscuro';
};

themeToggle.addEventListener('click', () => {
  if (document.body.classList.contains('theme-dark-green')) {
    removeDarkGreenTheme();
  } else {
    applyDarkGreenTheme();
  }
});

const playOverlay = document.getElementById('playOverlay');

playOverlay.addEventListener('click', () => {
  playOverlay.style.display = 'none';
});