-- Contextual voice requires one reviewed pronunciation for every token.
begin;
create function private.learning_ipa_valid_v1(p_value jsonb)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p_value)='string' and private.learning_utf16_length_v1(p_value#>>'{}')<=300
    and (p_value#>>'{}')~'^/[A-Za-zæçðøŋœθβχɐ-˿̀-ͯᴀ-ᵿ .ˈˌːˑ-]+/$',false);
$$;

create or replace function private.learning_details_valid_v1(p_row jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare
  lookup jsonb:=p_row->'wordLookup'; translation jsonb:=p_row->'translationAnalysis';
  coverage jsonb:=p_row->'coverageAnalysis'; rev jsonb:=coalesce(p_row->'textRevision','1'::jsonb);
  source text:=p_row->>'english'; token jsonb; surface text; token_index integer:=0;
  cursor_pos integer:=1; char_start integer; utf_start integer; item jsonb;
begin
  if not (p_row ?| array['wordLookup','translationAnalysis','coverageAnalysis']) then return true; end if;
  if not (p_row ?& array['chinese','wordLookup','translationAnalysis','coverageAnalysis'])
    or jsonb_typeof(rev) is distinct from 'number' or (rev#>>'{}')!~'^[1-9][0-9]*$'
    or jsonb_typeof(p_row->'english') is distinct from 'string'
    or not private.learning_detail_text_v1(p_row->'chinese',1000) then return false; end if;
  if jsonb_typeof(lookup) is distinct from 'object' or lookup->'schemaVersion' is distinct from '1'::jsonb
    or lookup->'sourceTextRevision' is distinct from rev or lookup->'sourceEnglish' is distinct from p_row->'english'
    or jsonb_typeof(lookup->'tokens') is distinct from 'array' then return false; end if;
  for surface in select matches[1] from regexp_matches(source,$re$[A-Za-z]+(?:['’‘‐‑–—-][A-Za-z]+)*$re$,'g') matches loop
    char_start:=cursor_pos+strpos(substring(source from cursor_pos),surface)-1;
    utf_start:=private.learning_utf16_length_v1(substring(source from 1 for char_start-1));
    token:=lookup->'tokens'->token_index;
    if jsonb_typeof(token) is distinct from 'object'
      or token->'tokenId' is distinct from to_jsonb('t'||token_index)
      or token->'surface' is distinct from to_jsonb(surface)
      or token->'start' is distinct from to_jsonb(utf_start)
      or token->'end' is distinct from to_jsonb(utf_start+private.learning_utf16_length_v1(surface))
      or not private.learning_detail_text_v1(token->'coreMeaningZh',160)
      or not private.learning_ipa_valid_v1(token->'pronunciationHint') then return false; end if;
    cursor_pos:=char_start+length(surface); token_index:=token_index+1;
  end loop;
  if jsonb_array_length(lookup->'tokens')<>token_index then return false; end if;
  for item in select value from jsonb_array_elements(coalesce(p_row->'expressions','[]'::jsonb)) loop
    if upper(coalesce(item->>'reviewStatus','')) in ('REJECTED','DELETED') then continue; end if;
    if coalesce(item->>'pronunciationHint','')<>''
      or (item->>'surface')~*'\m(read|live|wind|lead|tear|bow|close|does|bass|minute|wound|record|present|object|subject|invalid|refuse|content|produce|permit|desert)\M' then
      if not private.learning_ipa_valid_v1(item->'pronunciationHint') then return false; end if;
    end if;
  end loop;
  if jsonb_typeof(translation) is distinct from 'object'
    or translation->>'status' is distinct from 'completed'
    or translation->>'promptVersion' is distinct from 'context-lookup-v2-20260916'
    or translation->>'reviewVersion' is distinct from 'context-lookup-review-v2-20260916'
    or translation->'sourceTextRevision' is distinct from rev
    or jsonb_typeof(translation->'sourceConcerns') is distinct from 'array' then return false; end if;
  if jsonb_array_length(translation->'sourceConcerns')>5 then return false; end if;
  for item in select value from jsonb_array_elements(translation->'sourceConcerns') loop
    if not private.learning_detail_text_v1(item,300) then return false; end if;
  end loop;
  if jsonb_typeof(coverage) is distinct from 'object' or coverage->'schemaVersion' is distinct from '1'::jsonb
    or coverage->>'status' is distinct from 'completed'
    or coverage->>'promptVersion' is distinct from 'adjacent-coverage-v1-20260916'
    or coverage->>'reviewVersion' is distinct from 'adult-selection-review-v1-20260916'
    or coverage->'sourceTextRevision' is distinct from rev
    or jsonb_typeof(coverage->'pairs') is distinct from 'array'
    or p_row->'teachingAnalysis'->>'reviewVersion' is distinct from 'adult-selection-review-v1-20260916'
    then return false; end if;
  return jsonb_array_length(coverage->'pairs')<=2;
end $$;
revoke all on function private.learning_ipa_valid_v1(jsonb) from public,anon,authenticated,service_role;
commit;
