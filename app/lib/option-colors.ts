// Canonical user-selectable colors — DESIGN_SYSTEM.md §5.9i / §2.1.
// Never add Tailwind palette colors here.
export interface OptionColor {
  value: string;
  label: string;
}

export const OPTION_COLORS: OptionColor[] = [
  { value: "#F0C040", label: "Amber" },
  { value: "#8A7020", label: "Amber dim" },
  { value: "#4ADE80", label: "Green" },
  { value: "#2D7A4A", label: "Green dim" },
  { value: "#22D3EE", label: "Cyan" },
  { value: "#1A6B7A", label: "Cyan dim" },
  { value: "#FF4444", label: "Red" },
  { value: "#8A2020", label: "Red dim" },
  { value: "#F472B6", label: "Pink" },
  { value: "#8A4068", label: "Pink dim" },
  { value: "#6B6560", label: "Gray" },
  { value: "#B8B2AB", label: "Gray light" },
  { value: "#E8E4DE", label: "Gray pale" },
];
