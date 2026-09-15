-- Keep authorization authoritative even when the client already has this revision.
create or replace function public.get_published_content_if_changed_v1(p_known_revision bigint default null)
returns table(snapshot jsonb, revision bigint, published_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
declare v_access jsonb:=private.learning_access_v2(auth.uid());
begin
  if coalesce((v_access->>'canEnterLearning')::boolean,false) is not true then
    raise exception '%',coalesce(v_access->>'reason','ACCESS_DENIED') using errcode='42501';
  end if;
  return query select case when c.revision=p_known_revision then null else c.published end,
    c.revision,c.published_at from private.content_snapshots c where c.environment='production';
end;
$$;

-- A field patch prevents another device's unchanged settings from overwriting changes.
-- reviewedVideos is merged by video ID; JSON null removes an individual review mark.
create or replace function public.patch_learning_preferences_v1(p_patch jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid(); v_access jsonb; v_settings jsonb;
begin
  v_access:=private.learning_access_v2(v_user);
  if coalesce((v_access->>'canEnterLearning')::boolean,false) is not true then
    raise exception 'ACCESS_DENIED' using errcode='42501';
  end if;
  if p_patch is null or jsonb_typeof(p_patch)<>'object' or octet_length(p_patch::text)>65536
    or (p_patch ? 'reviewedVideos' and jsonb_typeof(p_patch->'reviewedVideos')<>'object') then
    raise exception 'PREFERENCES_INVALID' using errcode='22023';
  end if;
  insert into public.user_learning_preferences(user_id,settings,updated_at)
    values(v_user,'{}'::jsonb,now()) on conflict(user_id) do nothing;
  select settings into v_settings from public.user_learning_preferences where user_id=v_user for update;
  v_settings:=(case when jsonb_typeof(v_settings)='object' then v_settings else '{}'::jsonb end)||(p_patch-'reviewedVideos');
  if p_patch ? 'reviewedVideos' then
    v_settings:=jsonb_set(v_settings,'{reviewedVideos}',jsonb_strip_nulls(
      (case when jsonb_typeof(v_settings->'reviewedVideos')='object' then v_settings->'reviewedVideos' else '{}'::jsonb end)||(p_patch->'reviewedVideos')));
  end if;
  update public.user_learning_preferences set settings=v_settings,updated_at=now() where user_id=v_user;
  return jsonb_build_object('user_id',v_user,'settings',v_settings);
end;
$$;
revoke all on function public.get_published_content_if_changed_v1(bigint) from public,anon;
revoke all on function public.patch_learning_preferences_v1(jsonb) from public,anon;
grant execute on function public.get_published_content_if_changed_v1(bigint) to authenticated;
grant execute on function public.patch_learning_preferences_v1(jsonb) to authenticated;
