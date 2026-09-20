const meetingModeKey = "echoguide.meetingMode.v1";

export function loadMeetingMode(): boolean {
  try { return localStorage.getItem(meetingModeKey) === "true"; }
  catch { return false; }
}

export function saveMeetingMode(enabled: boolean): void {
  try { localStorage.setItem(meetingModeKey, String(enabled)); }
  catch { /* Storage is optional. */ }
}
