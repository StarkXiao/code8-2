import { useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  App as AntApp,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FALLBACK_RULE_KEY,
  NORMALIZATION_RULES,
  VAGUE_CATEGORIES,
  VAGUE_CATEGORY_LABELS,
  type FollowupTemplateItemDto,
  type VagueCategory,
} from '@froa/shared';
import { followupTemplateApi, workspaceApi } from '../../api/endpoints';
import { errorMessage } from '../../api/client';

/**
 * 追问话术模板页。
 *
 * 上半部分是"家族模板"（整理者维护，新人加入自动套用）；
 * 每条话术下面是自己的生效状态：可以换成我的问法，或临时停用 ——
 * 这些偏离只影响自己，别人看到的还是家族文案。
 */
export function TemplatesPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();

  const workspace = useQuery({
    queryKey: ['workspace', workspaceId],
    queryFn: () => workspaceApi.get(workspaceId!),
    enabled: Boolean(workspaceId),
  });

  const templates = useQuery({
    queryKey: ['followup-templates', workspaceId],
    queryFn: () => followupTemplateApi.list(workspaceId!),
    enabled: Boolean(workspaceId),
  });

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['followup-templates', workspaceId] });

  const canManage = workspace.data?.role === 'owner' || workspace.data?.role === 'editor';
  // 只读成员连"我的覆盖"也不能设 —— 与服务端的 contributor 门槛一致
  const canPersonalize = canManage || workspace.data?.role === 'contributor';

  const overrideMutation = useMutation({
    mutationFn: ({
      itemId,
      input,
    }: {
      itemId: string;
      input: { customQuestion?: string | null; disabled?: boolean; note?: string | null };
    }) => followupTemplateApi.setOverride(itemId, input),
    onSuccess: () => {
      invalidate();
      message.success('已更新我的问法（只对自己生效）');
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const clearOverrideMutation = useMutation({
    mutationFn: (itemId: string) => followupTemplateApi.clearOverride(itemId),
    onSuccess: () => {
      invalidate();
      message.success('已恢复继承家族文案');
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const familyMutation = useMutation({
    mutationFn: ({
      itemId,
      input,
    }: {
      itemId: string;
      input: { questionTemplate?: string; triggerText?: string | null; enabled?: boolean; category?: VagueCategory };
    }) => followupTemplateApi.updateItem(itemId, input),
    onSuccess: () => {
      invalidate();
      message.success('家族话术已更新，未覆盖的成员会自动跟上');
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const removeMutation = useMutation({
    mutationFn: (itemId: string) => followupTemplateApi.removeItem(itemId),
    onSuccess: () => {
      invalidate();
      message.success('已删除这条话术');
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const [overrideTarget, setOverrideTarget] = useState<FollowupTemplateItemDto | null>(null);
  const [familyTarget, setFamilyTarget] = useState<FollowupTemplateItemDto | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [newTemplateOpen, setNewTemplateOpen] = useState(false);

  const [overrideForm] = Form.useForm<{ customQuestion: string; note?: string }>();
  const [familyForm] = Form.useForm<{ questionTemplate: string; triggerText?: string; category: VagueCategory }>();
  const [addForm] = Form.useForm<{ category: VagueCategory; triggerText: string; questionTemplate: string }>();
  const [templateForm] = Form.useForm<{ name: string }>();

  const addItemMutation = useMutation({
    mutationFn: (values: { category: VagueCategory; triggerText: string; questionTemplate: string }) =>
      followupTemplateApi.addItem(workspaceId!, templates.data![0]!.id, values),
    onSuccess: () => {
      invalidate();
      setAddOpen(false);
      addForm.resetFields();
      message.success('已加入家族话术库');
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const createTemplateMutation = useMutation({
    mutationFn: (values: { name: string }) => followupTemplateApi.createTemplate(workspaceId!, values.name),
    onSuccess: () => {
      invalidate();
      setNewTemplateOpen(false);
      templateForm.resetFields();
      message.success('已创建新模板');
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  if (templates.isLoading || workspace.isLoading) return <Spin size="large" />;

  const allItems = (templates.data ?? []).flatMap((template) =>
    template.items.map((item) => ({ template, item })),
  );

  const openOverrideModal = (item: FollowupTemplateItemDto) => {
    overrideForm.setFieldsValue({
      customQuestion: item.myOverride?.customQuestion ?? item.questionTemplate,
      note: item.myOverride?.note ?? undefined,
    });
    setOverrideTarget(item);
  };

  const openFamilyModal = (item: FollowupTemplateItemDto) => {
    familyForm.setFieldsValue({
      questionTemplate: item.questionTemplate,
      triggerText: item.triggerText ?? undefined,
      category: item.category,
    });
    setFamilyTarget(item);
  };

  return (
    <div className="froa-stack">
      <div className="froa-page-title">
        <div>
          <h1>追问话术模板</h1>
          <div className="froa-hint">
            家族话术全空间共享，新人加入自动套用。你可以把某条换成自己的问法、或临时停用 —— 只影响自己。
          </div>
        </div>
        {canManage && (
          <Space wrap>
            <Button onClick={() => setNewTemplateOpen(true)}>新建模板</Button>
            <Button type="primary" onClick={() => setAddOpen(true)} disabled={!templates.data?.length}>
              加一条话术
            </Button>
          </Space>
        )}
      </div>

      {allItems.length === 0 ? (
        <Empty description="还没有话术条目" />
      ) : (
        allItems.map(({ template, item }) => (
          <div key={item.id} className="froa-card">
            <div className="froa-item-meta" style={{ marginBottom: 6 }}>
              <span className={`froa-tag-cat cat-${item.category}`}>
                {VAGUE_CATEGORY_LABELS[item.category]}
              </span>
              <span className="froa-hint">{triggerLabel(item)}</span>
              {templates.data!.length > 1 && <Tag>{template.name}</Tag>}
              {!item.enabled && <Tag color="red">家族已停用</Tag>}
              {item.myOverride?.disabledAt && <Tag color="orange">我已临时停用</Tag>}
              {item.effective.active && item.effective.source === 'override' && (
                <Tag color="blue">我的问法生效中</Tag>
              )}
            </div>

            <div style={{ marginBottom: 4 }}>
              <Typography.Text strong>家族文案：</Typography.Text>
              <Typography.Text delete={!item.enabled}>{item.questionTemplate}</Typography.Text>
            </div>

            {item.myOverride?.customQuestion && (
              <div style={{ marginBottom: 4 }}>
                <Typography.Text strong>我的问法：</Typography.Text>
                <Typography.Text type={item.myOverride.disabledAt ? 'secondary' : 'success'}>
                  {item.myOverride.customQuestion}
                </Typography.Text>
              </div>
            )}

            {item.myOverride?.note && (
              <div className="froa-hint" style={{ marginBottom: 4 }}>
                备注：{item.myOverride.note}
              </div>
            )}

            <Space wrap style={{ marginTop: 8 }}>
              {canPersonalize && (
                <>
                  <Button size="small" onClick={() => openOverrideModal(item)}>
                    {item.myOverride?.customQuestion ? '改我的问法' : '换成我的问法'}
                  </Button>
                  {item.myOverride?.disabledAt ? (
                    <Button
                      size="small"
                      onClick={() => overrideMutation.mutate({ itemId: item.id, input: { disabled: false } })}
                    >
                      恢复使用
                    </Button>
                  ) : (
                    <Button
                      size="small"
                      onClick={() => overrideMutation.mutate({ itemId: item.id, input: { disabled: true } })}
                    >
                      临时停用
                    </Button>
                  )}
                  {item.myOverride && (
                    <Button
                      size="small"
                      type="text"
                      onClick={() => clearOverrideMutation.mutate(item.id)}
                    >
                      恢复家族文案
                    </Button>
                  )}
                </>
              )}

              {canManage && (
                <>
                  <Button size="small" type="link" onClick={() => openFamilyModal(item)}>
                    编辑家族文案
                  </Button>
                  <span className="froa-hint">
                    家族级
                    <Switch
                      size="small"
                      checked={item.enabled}
                      style={{ margin: '0 4px' }}
                      onChange={(enabled) => familyMutation.mutate({ itemId: item.id, input: { enabled } })}
                    />
                    {item.enabled ? '启用中' : '已停用'}
                  </span>
                  <Popconfirm
                    title="删除这条家族话术？"
                    description="所有人的这条话术都会被移除（含个人覆盖），内置规则会回退到默认问法。"
                    onConfirm={() => removeMutation.mutate(item.id)}
                    okText="删除"
                    cancelText="取消"
                  >
                    <Button size="small" type="text" danger>
                      删除
                    </Button>
                  </Popconfirm>
                </>
              )}
            </Space>
          </div>
        ))
      )}

      {/* 换成我的问法 */}
      <Modal
        forceRender
        open={Boolean(overrideTarget)}
        title="换成我的问法（只对自己生效）"
        onCancel={() => setOverrideTarget(null)}
        onOk={() => overrideForm.submit()}
        okText="保存我的版本"
        cancelText="取消"
        confirmLoading={overrideMutation.isPending}
      >
        <Typography.Paragraph type="secondary">
          家族文案保持不变，其他成员不受影响。留空并保存等于恢复继承家族文案。可以用 {'{原话}'} 占位。
        </Typography.Paragraph>
        <Form
          form={overrideForm}
          layout="vertical"
          onFinish={(values) => {
            const custom = values.customQuestion?.trim();
            overrideMutation.mutate(
              {
                itemId: overrideTarget!.id,
                input: { customQuestion: custom || null, note: values.note ?? null },
              },
              { onSuccess: () => setOverrideTarget(null) },
            );
          }}
        >
          <Form.Item label="我的问法" name="customQuestion">
            <Input.TextArea rows={3} placeholder="留空则继承家族文案" />
          </Form.Item>
          <Form.Item label="备注（可选）" name="note">
            <Input placeholder="例如：问外婆时她更听得懂这种说法" maxLength={200} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑家族文案 */}
      <Modal
        forceRender
        open={Boolean(familyTarget)}
        title="编辑家族话术（全员共享）"
        onCancel={() => setFamilyTarget(null)}
        onOk={() => familyForm.submit()}
        okText="保存家族文案"
        cancelText="取消"
        confirmLoading={familyMutation.isPending}
      >
        <Typography.Paragraph type="secondary">
          改完后，没有个人覆盖的成员会自动看到新文案；已覆盖的成员保留自己的版本。
        </Typography.Paragraph>
        <Form
          form={familyForm}
          layout="vertical"
          onFinish={(values) => {
            familyMutation.mutate(
              {
                itemId: familyTarget!.id,
                input: {
                  questionTemplate: values.questionTemplate,
                  category: values.category,
                  ...(familyTarget!.ruleKey === null
                    ? { triggerText: values.triggerText ?? null }
                    : {}),
                },
              },
              { onSuccess: () => setFamilyTarget(null) },
            );
          }}
        >
          <Form.Item label="分类" name="category" rules={[{ required: true }]}>
            <Select
              options={VAGUE_CATEGORIES.map((value) => ({ value, label: VAGUE_CATEGORY_LABELS[value] }))}
            />
          </Form.Item>
          {familyTarget?.ruleKey === null && (
            <Form.Item
              label="触发词（转写文本里出现它时触发）"
              name="triggerText"
              rules={[{ required: true, message: '自定义话术需要触发词' }]}
            >
              <Input placeholder="例如：老汤" maxLength={64} />
            </Form.Item>
          )}
          <Form.Item label="家族文案" name="questionTemplate" rules={[{ required: true, message: '请填写话术' }]}>
            <Input.TextArea rows={3} placeholder={'可以用 {原话} 占位，发出时会替换成家人的原句'} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 新增自定义话术 */}
      <Modal
        forceRender
        open={addOpen}
        title="加一条家族话术"
        onCancel={() => setAddOpen(false)}
        onOk={() => addForm.submit()}
        okText="加入话术库"
        cancelText="取消"
        confirmLoading={addItemMutation.isPending}
      >
        <Typography.Paragraph type="secondary">
          转写文本里出现"触发词"时，这条话术就会出现在追问建议里。全空间成员自动继承。
        </Typography.Paragraph>
        <Form form={addForm} layout="vertical" onFinish={(values) => addItemMutation.mutate(values)}>
          <Form.Item label="分类" name="category" rules={[{ required: true, message: '请选择分类' }]}>
            <Select
              placeholder="这条话术问的是哪一类"
              options={VAGUE_CATEGORIES.map((value) => ({ value, label: VAGUE_CATEGORY_LABELS[value] }))}
            />
          </Form.Item>
          <Form.Item
            label="触发词"
            name="triggerText"
            rules={[{ required: true, message: '请填写触发词' }]}
          >
            <Input placeholder="例如：老汤、秘制、祖传" maxLength={64} />
          </Form.Item>
          <Form.Item
            label="话术"
            name="questionTemplate"
            rules={[{ required: true, message: '请填写话术' }]}
          >
            <Input.TextArea rows={3} placeholder={'例如：您说的"{原话}"是上次留下的那罐吗？'} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 新建模板 */}
      <Modal
        forceRender
        open={newTemplateOpen}
        title="新建话术模板"
        onCancel={() => setNewTemplateOpen(false)}
        onOk={() => templateForm.submit()}
        okText="创建"
        cancelText="取消"
        confirmLoading={createTemplateMutation.isPending}
      >
        <Typography.Paragraph type="secondary">
          一般一个"家族默认话术"就够用。想给不同长辈准备不同问法时，可以再建一套。
        </Typography.Paragraph>
        <Form form={templateForm} layout="vertical" onFinish={(values) => createTemplateMutation.mutate(values)}>
          <Form.Item label="模板名称" name="name" rules={[{ required: true, message: '请填写名称' }]}>
            <Input placeholder="例如：问爷爷的版本" maxLength={64} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

/** 这条话术什么时候会出现：内置规则 / 自定义触发词 / 兜底 */
function triggerLabel(item: FollowupTemplateItemDto): string {
  if (item.ruleKey === FALLBACK_RULE_KEY) return '兜底：没有命中任何规则时用这句';
  if (item.ruleKey) {
    const rule = NORMALIZATION_RULES.find((entry) => entry.id === item.ruleKey);
    return rule ? `内置规则：「${rule.example}」这类说法` : `内置规则：${item.ruleKey}`;
  }
  return `触发词：「${item.triggerText ?? ''}」`;
}
