import { useState } from 'react';
import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';
import { InputText } from 'primereact/inputtext';
import { Dropdown } from 'primereact/dropdown';
import {
  ProviderType,
  StoredConfig,
  DEFAULT_CONFIGS,
  getStoredConfig,
  setStoredConfig,
  clearStoredConfig,
} from '../ai/ai-service';

interface ApiKeyDialogProps {
  visible: boolean;
  onHide: () => void;
}

const PROVIDER_OPTIONS: { label: string; value: ProviderType }[] = [
  { label: 'OpenAI', value: 'openai' },
  { label: 'Anthropic', value: 'anthropic' },
];

export default function ApiKeyDialog({ visible, onHide }: ApiKeyDialogProps) {
  const stored = getStoredConfig();
  const [providerType, setProviderType] = useState<ProviderType>(stored?.type ?? 'openai');
  const [apiKey, setApiKey] = useState(stored?.apiKey ?? '');
  const [baseURL, setBaseURL] = useState(stored?.baseURL ?? '');
  const [model, setModel] = useState(stored?.model ?? DEFAULT_CONFIGS.openai.model);

  const defaults = DEFAULT_CONFIGS[providerType];

  const handleSave = () => {
    const key = apiKey.trim();
    if (!key) return;
    const url = baseURL.trim() || undefined;
    const mdl = model.trim() || defaults.model;

    const config: StoredConfig = {
      type: providerType,
      apiKey: key,
      model: mdl,
    };
    if (url) config.baseURL = url;

    setStoredConfig(config);
    onHide();
  };

  const handleRemove = () => {
    clearStoredConfig();
    setApiKey('');
  };

  const footerContent = (
    <div className="flex justify-content-end gap-2">
      {stored?.apiKey && (
        <Button
          label='Remove'
          icon='pi pi-trash'
          severity='danger'
          outlined
          onClick={handleRemove}
        />
      )}
      <Button label="Cancel" icon="pi pi-times" outlined onClick={onHide} />
      <Button
        label="Save Key"
        icon="pi pi-check"
        onClick={handleSave}
        disabled={!apiKey.trim()}
        autoFocus
      />
    </div>
  );

  return (
    <Dialog
      header="AI API Configuration"
      visible={visible}
      onHide={onHide}
      footer={footerContent}
      style={{ width: '520px', maxWidth: '95vw' }}
      closable
      modal
    >
      <div className='flex flex-column gap-3' style={{ marginBottom: '0.5rem' }}>
        {/* Provider selector */}
        <div className='flex flex-column gap-2'>
          <label style={{ fontWeight: 600, fontSize: '0.875rem' }}>Provider</label>
          <Dropdown
            value={providerType}
            options={PROVIDER_OPTIONS}
            onChange={e => {
              const pt = e.value as ProviderType;
              setProviderType(pt);
              setModel(DEFAULT_CONFIGS[pt].model);
              setBaseURL('');
            }}
            style={{ width: '100%' }}
          />
        </div>

        {/* API Key */}
        <div className='flex flex-column gap-2'>
          <label htmlFor='api-key-input' style={{ fontWeight: 600, fontSize: '0.875rem' }}>
            API Key
          </label>
          <InputText
            id='api-key-input'
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder='sk-...'
            style={{ width: '100%' }}
          />
        </div>

        {/* Base URL */}
        <div className='flex flex-column gap-2'>
          <label htmlFor='baseurl-input' style={{ fontWeight: 600, fontSize: '0.875rem' }}>
            Base URL{' '}
            <span style={{ fontWeight: 400, fontSize: '0.75rem', color: 'var(--text-color-secondary)' }}>
              (optional — for custom proxies/gateways)
            </span>
          </label>
          <InputText
            id='baseurl-input'
            value={baseURL}
            onChange={e => setBaseURL(e.target.value)}
            placeholder={providerType === 'anthropic'
              ? 'https://api.anthropic.com/v1'
              : 'https://api.openai.com/v1'}
            style={{ width: '100%' }}
          />
        </div>

        {/* Model */}
        <div className='flex flex-column gap-2'>
          <label htmlFor='model-input' style={{ fontWeight: 600, fontSize: '0.875rem' }}>
            Model ID
          </label>
          <InputText
            id='model-input'
            value={model}
            onChange={e => setModel(e.target.value)}
            placeholder={defaults.model}
            style={{ width: '100%' }}
          />
        </div>
      </div>
    </Dialog>
  );
}
