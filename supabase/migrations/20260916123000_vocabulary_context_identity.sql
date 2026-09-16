begin;

-- Nullable identity extends existing collections without changing their keys,
-- review history, ownership policies or legacy contextual definitions.
alter table public.user_vocabulary
  add column if not exists source_token_id text,
  add column if not exists source_text_revision integer;

alter table public.user_vocabulary
  add constraint vocabulary_source_token_id_valid
    check (source_token_id is null or (length(source_token_id) between 1 and 128 and source_token_id = btrim(source_token_id))),
  add constraint vocabulary_source_text_revision_valid
    check (source_text_revision is null or source_text_revision >= 1);

comment on column public.user_vocabulary.source_token_id is
  'Token occurrence within source_sentence_id at source_text_revision; null for legacy or phrase collections.';
comment on column public.user_vocabulary.source_text_revision is
  'Revision of the source sentence used for the saved contextual meaning; null for legacy collections.';

commit;
