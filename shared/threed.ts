// Gemeinsame Typen für die 3D-Werkzeuge (Blender, Blockbench).
export type ToolId = 'blender' | 'blockbench';

export interface ToolStatus {
  id: ToolId;
  installed: boolean;
  version?: string;
  /** Blockbench: Community-MCP-Plugin installiert. */
  mcp?: boolean;
  /** Sandbox, in der das Werkzeug läuft. `none`: nur eigener Ordner und bereinigte Umgebung. */
  sandbox: 'bubblewrap' | 'none';
  size: number;
}

export interface AnimationPreview {
  name: string;
  length: number;
  loop: 'once' | 'loop' | 'hold';
  frames: string[];
}
