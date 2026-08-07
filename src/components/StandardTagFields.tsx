import { Fragment } from 'react'
import { Check } from 'lucide-react'
import { STANDARD_TAG_FACETS, facetForTag } from '../services/standardTags'

interface StandardTagFieldsProps {
  // Unique per example, so the labels and controls of one row cannot be
  // confused with another's
  idPrefix: string
  // The standard tags currently on the example; everything else is ignored
  tags: string[]
  // An exclusive facet was set to a value, or to none when the tag is empty
  onFacetChosen: (facetId: string, tag: string) => void
  // One value of a facet that takes several was turned on or off
  onFeatureToggled: (tag: string) => void
}

// The fixed part of the tag vocabulary (story 8.17), as controls rather than
// text: a facet with one value is a select, so it can be set, changed and
// cleared without a spelling to get wrong, and a facet that takes several is
// a row of chips. Free-form topic tags stay a text field alongside these.
export const StandardTagFields = ({
  idPrefix,
  tags,
  onFacetChosen,
  onFeatureToggled
}: StandardTagFieldsProps) => (
  <>
    {STANDARD_TAG_FACETS.map(facet => {
      if (facet.exclusive) {
        const controlId = `${idPrefix}_${facet.id}`
        const chosen = tags.find(tag => facetForTag(tag)?.id === facet.id) ?? ''
        return (
          <Fragment key={facet.id}>
            <label className="sr-only" htmlFor={controlId}>
              {facet.label}
            </label>
            <select
              className="standard-tag-facet"
              id={controlId}
              value={chosen}
              onChange={event => onFacetChosen(facet.id, event.target.value)}
            >
              <option value="">{facet.label}: unsaid</option>
              {facet.options.map(option => (
                <option key={option.tag} value={option.tag} title={option.help}>
                  {facet.label}: {option.label}
                </option>
              ))}
            </select>
          </Fragment>
        )
      }

      // A group rather than a fieldset: the chips sit inline among the
      // selects, and a legend cannot be laid out inline without fighting the
      // way browsers render it over the fieldset's border.
      //
      // Each value is a chip rather than a checkbox: the tags this facet
      // carries are what the row already shows as pills elsewhere, so picking
      // them looks like what is picked, and the ones that are on read at a
      // glance instead of asking the eye to find four small ticks.
      const labelId = `${idPrefix}_${facet.id}_label`
      return (
        <div
          key={facet.id}
          className="standard-tag-features"
          role="group"
          aria-labelledby={labelId}
        >
          <span id={labelId}>{facet.label}</span>
          {facet.options.map(option => {
            const chosen = tags.includes(option.tag)
            return (
              <button
                key={option.tag}
                type="button"
                className="chip"
                title={option.help}
                aria-pressed={chosen}
                onClick={() => onFeatureToggled(option.tag)}
              >
                {chosen && <Check size={12} aria-hidden="true" />}
                {option.label}
              </button>
            )
          })}
        </div>
      )
    })}
  </>
)
