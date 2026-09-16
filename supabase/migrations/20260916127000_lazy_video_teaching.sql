-- Keep word dictionaries and generated-audio manifests out of the home catalog.
-- Existing snapshot RPCs remain unchanged for old deployed clients.
create or replace function private.learner_catalog_projection_v2(p_snapshot jsonb)
returns jsonb language sql immutable set search_path='' as $$
  select p_snapshot || jsonb_build_object(
    'videos', coalesce((select jsonb_agg(v.value-'voiceManifest' order by v.ordinality)
      from jsonb_array_elements(coalesce(p_snapshot->'videos','[]'::jsonb)) with ordinality v), '[]'::jsonb),
    'sentences', coalesce((select jsonb_object_agg(s.key,
      coalesce((select jsonb_agg(r.value-'wordLookup' order by r.ordinality)
        from jsonb_array_elements(s.value) with ordinality r), '[]'::jsonb))
      from jsonb_each(coalesce(p_snapshot->'sentences','{}'::jsonb)) s), '{}'::jsonb));
$$;

create or replace function public.get_published_catalog_if_changed_v2(p_known_revision bigint default null)
returns table(snapshot jsonb, revision bigint, published_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
declare access jsonb:=private.learning_access_v2(auth.uid());
begin
  if coalesce((access->>'canEnterLearning')::boolean,false) is not true then
    raise exception '%',coalesce(access->>'reason','ACCESS_DENIED') using errcode='42501';
  end if;
  return query select case when c.revision=p_known_revision then null
      else private.learner_catalog_projection_v2(c.published) end,
    c.revision,c.published_at from private.content_snapshots c where c.environment='production';
end;
$$;

create or replace function public.get_published_video_teaching_v1(p_video_id text,p_known_revision bigint default null)
returns table(video jsonb,sentences jsonb,revision bigint)
language plpgsql stable security definer set search_path='' as $$
declare access jsonb:=private.learning_access_v2(auth.uid()); c private.content_snapshots%rowtype; target jsonb;
begin
  if coalesce((access->>'canEnterLearning')::boolean,false) is not true then
    raise exception '%',coalesce(access->>'reason','ACCESS_DENIED') using errcode='42501';
  end if;
  select * into c from private.content_snapshots where environment='production';
  select v.value into target from jsonb_array_elements(coalesce(c.published->'videos','[]'::jsonb)) v
    where v.value->>'id'=p_video_id and v.value->>'status'='PUBLISHED';
  if target is null then raise exception 'VIDEO_NOT_FOUND' using errcode='22023'; end if;
  return query select case when c.revision=p_known_revision then null else target end,
    case when c.revision=p_known_revision then null else coalesce(c.published->'sentences'->p_video_id,'[]'::jsonb) end,
    c.revision;
end;
$$;
revoke all on function private.learner_catalog_projection_v2(jsonb) from public,anon,authenticated;
revoke all on function public.get_published_catalog_if_changed_v2(bigint),
  public.get_published_video_teaching_v1(text,bigint) from public,anon;
grant execute on function public.get_published_catalog_if_changed_v2(bigint),
  public.get_published_video_teaching_v1(text,bigint) to authenticated;
