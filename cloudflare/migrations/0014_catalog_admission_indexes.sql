-- Keep the denormalized browse and delivery indexes aligned with the admission
-- decisions stored in each internship document. Posting-identity repair versions
-- before this migration rebuilt these columns from technical/open status alone.
UPDATE catalog_items
SET sms_pending = 0,
    digest_pending = 0
WHERE kind = 'internship'
  AND json_extract(value, '$.admission.alertEligible') = 0;

UPDATE catalog_items
SET catalog_state = NULL,
    catalog_sort_key = NULL,
    search_text = NULL,
    source_classes = NULL
WHERE kind = 'internship'
  AND json_extract(value, '$.admission.catalogEligible') = 0;
