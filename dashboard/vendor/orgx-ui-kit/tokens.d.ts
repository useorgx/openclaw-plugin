/* Generated from tokens/tokens.json; do not edit. */
declare const tokens: {
  "$description": "OrgX design tokens. Single source for dist/tokens.css, dist/tokens.js and dist/tailwind-preset.cjs. Values come from the OrgX design canvas (ox.css): dark is the canvas :root, light is the canvas .lt (AA on white) theme. Every key under color.* becomes --ox-<key>.",
  "version": "0.2.0-alpha.0",
  "color": {
    "light": {
      "bg": "#ffffff",
      "panel": "#ffffff",
      "panel-solid": "#ffffff",
      "well-bg": "#f3f4f6",
      "well-shadow": "none",
      "border": "rgba(15,23,42,.09)",
      "border-strong": "rgba(15,23,42,.18)",
      "text": "#0f172a",
      "text-2": "rgba(15,23,42,.76)",
      "text-muted": "rgba(15,23,42,.58)",
      "teal": "#0b7a6b",
      "warning": "#8a5a00",
      "danger": "#c0262d",
      "lime": "#4d7c0f",
      "iris": "#4f46e5",
      "mute": "#64748b",
      "primary-rgb": "251,191,36",
      "on-primary": "#1a1204",
      "primary-hold": "#b45309",
      "primary-border": "#e9a800",
      "edge-amber-rgb": "217,154,6",
      "edge-teal-rgb": "20,163,143",
      "edge-red-rgb": "217,45,32",
      "edge-mute-rgb": "100,116,139",
      "ring-track": "rgba(15,23,42,.12)",
      "skeleton": "rgba(15,23,42,.08)",
      "hover": "rgba(15,23,42,.04)",
      "focus": "#8a5a00",
      "shadow": "0 1px 2px rgba(15,23,42,.06),0 8px 24px -12px rgba(15,23,42,.18)"
    },
    "dark": {
      "bg": "#02040a",
      "panel": "rgba(10,15,22,.96)",
      "panel-solid": "#0a0f16",
      "well-bg": "rgba(0,0,0,.3)",
      "well-shadow": "inset 0 2px 10px rgba(0,0,0,.4)",
      "border": "rgba(255,255,255,.08)",
      "border-strong": "rgba(255,255,255,.15)",
      "text": "#f8fafc",
      "text-2": "rgba(255,255,255,.72)",
      "text-muted": "rgba(255,255,255,.52)",
      "teal": "#00C9A7",
      "warning": "#FBBF24",
      "danger": "#F43F5E",
      "lime": "#D4ED31",
      "iris": "#6366f1",
      "mute": "#94A3B8",
      "primary-rgb": "251,191,36",
      "on-primary": "#1a1204",
      "primary-hold": "#b45309",
      "primary-border": "transparent",
      "edge-amber-rgb": "251,191,36",
      "edge-teal-rgb": "0,201,167",
      "edge-red-rgb": "244,63,94",
      "edge-mute-rgb": "148,163,184",
      "ring-track": "rgba(255,255,255,.12)",
      "skeleton": "rgba(255,255,255,.08)",
      "hover": "rgba(255,255,255,.04)",
      "focus": "rgba(251,191,36,.8)",
      "shadow": "0 16px 40px -10px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.05)"
    }
  },
  "font": {
    "font": "-apple-system,BlinkMacSystemFont,\"Segoe UI\",system-ui,sans-serif",
    "mono": "\"JetBrains Mono\",ui-monospace,SFMono-Regular,monospace"
  },
  "type": {
    "label": {
      "size": "10.5px",
      "lineHeight": "1.2",
      "weight": "600",
      "tracking": ".12em",
      "family": "mono",
      "transform": "uppercase"
    },
    "meta": {
      "size": "11.5px",
      "lineHeight": "1.3",
      "weight": "500",
      "tracking": "0",
      "family": "mono"
    },
    "small": {
      "size": "12.5px",
      "lineHeight": "1.45",
      "weight": "400",
      "tracking": "0",
      "family": "font"
    },
    "body": {
      "size": "14px",
      "lineHeight": "1.5",
      "weight": "400",
      "tracking": "0",
      "family": "font"
    },
    "title-md": {
      "size": "17px",
      "lineHeight": "1.3",
      "weight": "650",
      "tracking": "-.015em",
      "family": "font"
    },
    "title-lg": {
      "size": "22px",
      "lineHeight": "1.2",
      "weight": "700",
      "tracking": "-.025em",
      "family": "font"
    },
    "title-xl": {
      "size": "30px",
      "lineHeight": "1.15",
      "weight": "700",
      "tracking": "-.03em",
      "family": "font"
    }
  },
  "radius": {
    "xs": "4px",
    "sm": "6px",
    "btn-sm": "9px",
    "md": "10px",
    "btn": "12px",
    "lg": "14px",
    "card": "16px",
    "xl": "18px",
    "stage": "22px",
    "pill": "999px"
  },
  "space": {
    "1": "4px",
    "2": "8px",
    "3": "12px",
    "4": "16px",
    "5": "20px",
    "6": "24px",
    "2.5": "10px",
    "3.5": "14px",
    "4.5": "18px"
  },
  "size": {
    "touch": "44px",
    "control-sm": "36px",
    "footer": "64px",
    "status-icon": "22px"
  },
  "motion": {
    "duration": {
      "crossfade": "120ms",
      "micro": "160ms",
      "standard": "180ms",
      "medium": "220ms",
      "check": "240ms",
      "failure": "300ms",
      "sending-delay": "300ms",
      "sending-min": "400ms",
      "edge": "600ms",
      "pulse": "1000ms",
      "hold": "1000ms",
      "undo": "10000ms",
      "stagger": "40ms"
    },
    "easing": {
      "out": "cubic-bezier(.16,1,.3,1)",
      "linear": "linear",
      "standard": "cubic-bezier(.2,0,0,1)"
    }
  },
  "agent": {
    "pace": {
      "name": "Pace",
      "domain": "Product",
      "hue": "#14b8a6"
    },
    "eli": {
      "name": "Eli",
      "domain": "Engineering",
      "hue": "#22c55e"
    },
    "mark": {
      "name": "Mark",
      "domain": "Marketing",
      "hue": "#f97316"
    },
    "sage": {
      "name": "Sage",
      "domain": "Sales",
      "hue": "#ec4899"
    },
    "orion": {
      "name": "Orion",
      "domain": "Operations",
      "hue": "#84cc16"
    },
    "dana": {
      "name": "Dana",
      "domain": "Design",
      "hue": "#a855f7"
    },
    "xandy": {
      "name": "Xandy",
      "domain": "Orchestrator",
      "hue": "#6366f1"
    }
  },
  "avatar": {
    "forms": [
      "base",
      "strategic",
      "proactive",
      "working",
      "asking",
      "verifying"
    ],
    "sizes": [
      48,
      96,
      192
    ],
    "file": "{agent}-{form}-{size}.webp",
    "full": "{agent}-{form}-full.webp"
  }
};
export { tokens };
export default tokens;
