import { Fragment } from 'react'
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
// checkboxes. Free-form topic tags stay a text field alongside these.
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

      // A group rather than a fieldset: the checkboxes sit inline among the
      // selects, and a legend cannot be laid out inline without fighting the
      // way browsers render it over the fieldset's border
      const labelId = `${idPrefix}_${facet.id}_label`
      return (
        <div
          key={facet.id}
          className="standard-tag-features"
          role="group"
          aria-labelledby={labelId}
        >
          <span id={labelId}>{facet.label}</span>
          {facet.options.map(option => (
            <label key={option.tag} title={option.help}>
              <input
                type="checkbox"
                checked={tags.includes(option.tag)}
                onChange={() => onFeatureToggled(option.tag)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      )
    })}
  </>
)
