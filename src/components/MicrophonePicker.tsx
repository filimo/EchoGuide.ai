import { useEffect, useState } from "react";

type Props = {
  value: string;
  onChange: (deviceId: string) => void;
  disabled: boolean;
  stream: MediaStream | null;
};

export function MicrophonePicker({ value, onChange, disabled, stream }: Props) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media?.enumerateDevices) return;
    let cancelled = false;
    let revision = 0;
    async function refresh() {
      const current = ++revision;
      try {
        const inputs = (await media.enumerateDevices()).filter(device => device.kind === "audioinput");
        if (!cancelled && current === revision) {
          setDevices(inputs);
          setError("");
        }
      } catch {
        if (!cancelled && current === revision) setError("Could not list microphones.");
      }
    }
    void refresh();
    media.addEventListener?.("devicechange", refresh);
    return () => {
      cancelled = true;
      media.removeEventListener?.("devicechange", refresh);
    };
  }, [stream]);
  const missing = value !== "default" && !devices.some(device => device.deviceId === value);
  return <label className="microphone-picker">
    <select aria-label="Microphone" value={value} disabled={disabled}
      title={disabled ? "Stop the meeting before changing microphones." : "Choose the meeting audio input."}
      onChange={event => onChange(event.target.value)}>
      <option value="default">System default</option>
      {missing && <option value={value}>Saved microphone (unavailable)</option>}
      {devices.filter(device => device.deviceId && device.deviceId !== "default").map((device, index) =>
        <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}
    </select>
    {error && <span role="status">{error}</span>}
  </label>;
}
