import type { Config } from 'tailwindcss';

export default {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        background: '#09090b',
        bg:         '#09090b',
        surface:    '#111113',
        surface2:   '#18181b',
        border:     '#27272a',
        'border-h': '#3f3f46',
        text:       '#f4f4f5',
        'text-2':   '#d4d4d8',
        muted:      '#71717a',
        muted2:     '#52525b',
        accent:     '#22c55e',
        'accent-h': '#16a34a',
        'accent-secondary': '#10b981',
        danger:     '#ef4444',
        'danger-h': '#dc2626',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
