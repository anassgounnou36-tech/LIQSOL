/**
 * Normalize Windows-style paths to WSL format if running in WSL environment.
 * Converts paths like C:\Users\... to /mnt/c/Users/...
 * 
 * @param windowsPath - Path potentially in Windows format
 * @returns Normalized path for the current environment
 */
export function normalizeWslPath(windowsPath: string): string {
  if (!windowsPath) return windowsPath;
  
  // Check if path looks like a Windows absolute path (e.g., C:\... or C:/...)
  const winPathMatch = windowsPath.match(/^([A-Z]):[/\\]/i);
  
  if (!winPathMatch) {
    // Not a Windows-style path, return as-is
    return windowsPath;
  }
  
  // Extract drive letter and convert to lowercase
  const driveLetter = winPathMatch[1].toLowerCase();
  
  // Remove the drive letter and colon, normalize backslashes to forward slashes
  const pathWithoutDrive = windowsPath.slice(2).replace(/\\/g, '/');
  
  // Convert to WSL format: /mnt/{drive}/{path}
  return `/mnt/${driveLetter}${pathWithoutDrive}`;
}
