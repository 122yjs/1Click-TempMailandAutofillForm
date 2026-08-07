<script lang="ts">
import { t } from 'svelte-i18n';
import ModalDialog from '@/ui/components/composites/ModalDialog.svelte';
import Icon from '@/ui/components/icons/Icon.svelte';
import { Btn } from '@/ui/components/primitives';
import { getErrorMessage } from '@/utils/errors.js';
import { validateTextInput } from '@/utils/validation.js';

interface Props {
  open: boolean;
  currentTag: string | null;
  currentTagColor: string | null;
  /** Multi-tag: currently assigned tags on the address */
  currentTags?: Array<{ name: string; color: string }>;
  existingTags: string[];
  tagColors: Record<string, string>;
  onClose: () => void;
  onSave: (tag: string, color: string) => void;
  /** Preferred multi-tag save (full list) */
  onSaveTags?: (tags: Array<{ name: string; color: string }>) => void;
  portal?: boolean;
}
let {
  open,
  currentTag,
  currentTagColor,
  currentTags = [],
  existingTags,
  tagColors,
  onClose,
  onSave,
  onSaveTags,
  portal = true,
}: Props = $props();

let tagInput = $state('');
let selectedExistingTag = $state<string | null>(null);
let selectedColor = $state('#6366F1');
let selectedTags = $state<Array<{ name: string; color: string }>>([]);
let validationError = $state('');
let dialogRef = $state<HTMLElement | null>(null);

function getTagInkToken(color: string): string {
  const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!hex) return 'var(--md-on-primary)';
  let h = hex[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const lum = 0.2126 * (r / 255) + 0.7152 * (g / 255) + 0.0722 * (b / 255);
  return lum > 0.45 ? 'var(--md-on-surface)' : 'var(--md-on-primary)';
}

// Initialize with current tag(s) when dialog opens
$effect(() => {
  if (!open) return;
  validationError = '';
  if (currentTags.length > 0) {
    selectedTags = [...currentTags];
    tagInput = '';
    selectedExistingTag = null;
    selectedColor = '#6366F1';
  } else if (currentTag) {
    selectedTags = [
      { name: currentTag, color: currentTagColor || tagColors[currentTag] || '#6366F1' },
    ];
    tagInput = '';
    selectedExistingTag = currentTag;
    selectedColor = currentTagColor || tagColors[currentTag] || '#6366F1';
  } else {
    selectedTags = [];
    tagInput = '';
    selectedExistingTag = null;
    selectedColor = '#6366F1';
  }
});

const defaultColors = [
  '#6366F1', // Indigo
  '#EC4899', // Pink
  '#10B981', // Emerald
  '#F59E0B', // Amber
  '#3B82F6', // Blue
  '#8B5CF6', // Purple
  '#EF4444', // Red
  '#06B6D4', // Cyan
];

function toggleTag(name: string, color: string) {
  const idx = selectedTags.findIndex((t) => t.name.toLowerCase() === name.toLowerCase());
  if (idx >= 0) {
    selectedTags = selectedTags.filter((_, i) => i !== idx);
  } else {
    selectedTags = [...selectedTags, { name, color }];
  }
}

function handleAddTypedTag() {
  const trimmed = tagInput.trim();
  if (!trimmed) return;

  try {
    const sanitized = validateTextInput(trimmed, $t('common.addTag'), 32);
    validationError = '';
    toggleTag(sanitized, selectedColor);
    tagInput = '';
  } catch (err) {
    validationError = getErrorMessage(err);
  }
}

function handleSave() {
  validationError = '';
  try {
    if (tagInput.trim()) {
      handleAddTypedTag();
      if (validationError) return;
    }
    if (onSaveTags) {
      onSaveTags(selectedTags);
    } else if (selectedTags.length > 0) {
      onSave(selectedTags[0].name, selectedTags[0].color);
    } else {
      onSave('', '');
    }
    onClose();
  } catch (err) {
    validationError = getErrorMessage(err);
  }
}
</script>

<ModalDialog
  {open}
  title={$t('tagManagement.setTags') || 'Set Tags'}
  subtitle={$t('tagManagement.setTagsHint') || 'Add multiple tags — toggle existing or type a new one'}
  maxWidth="sm"
  {onClose}
  bind:dialogRef
>
  {#if selectedTags.length > 0}
    <div class="flex flex-wrap gap-1.5 mb-2">
      {#each selectedTags as st (st.name)}
        <button
          type="button"
          class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold shadow-xs transition-transform active:scale-95"
          style="background-color: {st.color}; color: {getTagInkToken(st.color)};"
          onclick={() => toggleTag(st.name, st.color)}
          title={$t('common.removeTag') || 'Click to remove'}
        >
          <span>{st.name}</span>
          <Icon name="x" class="w-3 h-3 opacity-80 hover:opacity-100" />
        </button>
      {/each}
    </div>
  {/if}

  {#if validationError}
    <p class="text-xs text-md-error bg-md-error-container/40 px-3 py-1.5 rounded-lg mb-2">{validationError}</p>
  {/if}

  <!-- Type new tag -->
  <div class="space-y-2 mb-3">
    <div class="flex gap-2">
      <input
        id="input-tag-name"
        type="text"
        placeholder={$t('tagManagement.tagNamePlaceholder') || 'Enter tag name...'}
        bind:value={tagInput}
        class="flex-1 px-3 py-1.5 text-xs rounded-xl bg-md-surface border border-md-outline-variant/30 text-md-on-surface outline-none focus:border-md-primary"
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            handleAddTypedTag();
          }
        }}
      />
      <Btn
        variant="tonal"
        size="sm"
        onclick={handleAddTypedTag}
      >
        {$t('common.add') || 'Add'}
      </Btn>
    </div>

    <!-- Color selector -->
    <div class="flex items-center gap-1.5 overflow-x-auto py-1">
      {#each defaultColors as c (c)}
        <button
          type="button"
          class="w-5 h-5 rounded-full border-2 transition-transform shrink-0 {selectedColor === c ? 'border-md-on-surface scale-110' : 'border-transparent hover:scale-105'}"
          style="background-color: {c}"
          onclick={() => selectedColor = c}
          aria-label={c}
        ></button>
      {/each}
    </div>
  </div>

  <!-- Existing tags list -->
  {#if existingTags.length > 0}
    <div class="space-y-1.5 pt-2 border-t border-md-outline-variant/15">
      <div class="text-xs font-medium text-md-on-surface/60 px-1">{$t('tagManagement.existingTags') || 'Existing Tags'}</div>
      <div class="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto p-1">
        {#each existingTags as tag (tag)}
          {@const color = tagColors[tag] || '#6366F1'}
          {@const isAssigned = selectedTags.some(t => t.name.toLowerCase() === tag.toLowerCase())}
          <button
            type="button"
            class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-all {isAssigned ? 'bg-md-primary text-md-on-primary border-md-primary font-semibold' : 'bg-md-surface-variant/40 text-md-on-surface border-md-outline-variant/30 hover:bg-md-surface-variant'}"
            onclick={() => toggleTag(tag, color)}
          >
            <span class="w-2 h-2 rounded-full shrink-0" style="background-color: {color}"></span>
            <span>{tag}</span>
            {#if isAssigned}
              <Icon name="check" class="w-3 h-3" />
            {/if}
          </button>
        {/each}
      </div>
    </div>
  {/if}

  {#snippet footer()}
    <Btn
      id="button-cancel-tag"
      variant="secondary"
      size="md"
      onclick={(e) => { e.stopPropagation(); onClose(); }}
    >
      {$t('common.cancel')}
    </Btn>
    <Btn
      id="button-save-tag"
      variant="primary"
      size="md"
      onclick={(e) => { e.stopPropagation(); handleSave(); }}
    >
      {$t('common.save')}
    </Btn>
  {/snippet}
</ModalDialog>
