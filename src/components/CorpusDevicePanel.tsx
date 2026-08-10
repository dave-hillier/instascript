import { ScanText, Trash2 } from 'lucide-react'
import type { ExampleRecord } from '../types/example'
import type { CorpusDeviceSet } from '../services/corpusDevices'
import { deviceSourcesIn } from '../services/corpusDevices'
import { describeDeviceStaleness } from '../services/deviceExtraction'
import {
  DEVICE_PROGRESS_LABELS,
  type ImportFileProgress
} from '../services/importProgress'
import { ImportProgressMeter } from './ImportProgressMeter'

interface CorpusDevicePanelProps {
  folder: string
  headingId: string
  examples: ExampleRecord[]
  // What was read from this folder, or null where it has never been read
  devices: CorpusDeviceSet | null
  stale: boolean
  // The rows of a run over this folder, empty when the last run was somewhere
  // else, and the line it finished on
  files: ImportFileProgress[]
  note: string | null
  // Whether a run is going anywhere on the page: they go one at a time
  running: boolean
  onExtract: (folder: string, examples: ExampleRecord[]) => void
  onCleared: (folder: string) => void
}

// Story 8.20: what this folder's scripts have in common, and the control that
// reads it out of them. The exemplars themselves are quoted to the model in
// full every generation, but what they share is never said out loud — so it
// is said here, where it can also be read by the person who collected them.
export const CorpusDevicePanel = ({
  folder,
  headingId,
  examples,
  devices,
  stale,
  files,
  note,
  running,
  onExtract,
  onCleared
}: CorpusDevicePanelProps) => {
  const sources = deviceSourcesIn(examples)
  const staleness = describeDeviceStaleness(stale, devices?.sources ?? 0)

  // An empty folder has nothing to say about itself, and nothing anybody
  // could press a button to find out
  if (examples.length === 0 && !devices) return null

  return (
    <section className="example-devices" aria-labelledby={`${headingId}_devices`}>
      <header>
        <h4 id={`${headingId}_devices`}>Devices</h4>
        {devices && (
          <p className="example-devices-meta">
            {devices.devices.length} from {devices.sources}{' '}
            {devices.sources === 1 ? 'script' : 'scripts'}
            {devices.model ? ` · ${devices.model}` : ''}
          </p>
        )}
        <div className="example-devices-actions">
          {sources.length > 0 && (
            <button
              type="button"
              disabled={running}
              onClick={() => onExtract(folder, examples)}
              aria-describedby={`${headingId}_devices_help`}
            >
              <ScanText size={14} />
              {devices ? 'Read again' : `Read ${sources.length}`}
            </button>
          )}
          {devices && (
            <button
              type="button"
              className="example-devices-clear"
              disabled={running}
              onClick={() => onCleared(folder)}
            >
              <Trash2 size={14} />
              Clear
            </button>
          )}
        </div>
      </header>

      <p className="example-devices-help" id={`${headingId}_devices_help`}>
        {sources.length === 0
          ? 'Nothing here is long enough to read for devices yet.'
          : devices
            ? 'These are sent with the exemplars every time this folder grounds a generation, and the style review judges against them as well as against the rules.'
            : 'The utility model reads each script for the moves it makes, then says which of them this collection has in common. What it finds is sent with the exemplars, so the style the corpus is in is stated rather than left to be inferred.'}
      </p>

      {staleness && (
        <p className="example-devices-stale" role="status">
          {staleness}
        </p>
      )}

      <ImportProgressMeter files={files} labels={DEVICE_PROGRESS_LABELS} />

      {note && (
        <p className="example-devices-result" role="status" aria-live="polite">
          {note}
        </p>
      )}

      {devices && (
        <ol className="example-device-list">
          {devices.devices.map(device => (
            <li key={device.name}>
              <p className="example-device-name">{device.name}</p>
              <p className="example-device-instruction">{device.instruction}</p>
              {device.quote && (
                <blockquote className="example-device-quote">{device.quote}</blockquote>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
