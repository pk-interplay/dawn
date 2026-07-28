-- Promote goals & background to first-class profile primitives.
--
-- Dawn's onboarding already elicits these ("what are you trying to become?"
-- and the member's career history), but until now they were folded into `bio`
-- and only kept client-side. Storing them as their own arrays makes them
-- durable, queryable, and available to the reranker as sharper signal than
-- freeform prose.
alter table people
  add column goals       text[] default '{}',  -- what they want next / are reaching for
  add column background  text[] default '{}';  -- key points of career history
