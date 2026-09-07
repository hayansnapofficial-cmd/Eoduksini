import Stripe from 'stripe';

const periodEnd=subscription=>subscription.current_period_end??(Math.max(0,...(subscription.items?.data??[])
  .map(item=>item.current_period_end??0))||null);

export function createBilling({secretKey,webhookSecret,priceId,origin,store,stripeClient=null}={}) {
  const configured=Boolean(secretKey && webhookSecret && priceId && origin && store);
  const stripe=stripeClient??(secretKey?new Stripe(secretKey):null);
  const checkout=async session=>{
    if(!configured) throw new Error('BILLING_NOT_CONFIGURED');
    if(store.entitlement(session.user.github_id).active) throw new Error('SUBSCRIPTION_ALREADY_ACTIVE');
    const user=store.user(session.user.github_id),metadata={github_user_id:user.github_id};
    const value=await stripe.checkout.sessions.create({mode:'subscription',line_items:[{price:priceId,quantity:1}],
      success_url:origin+'/account?checkout=success',cancel_url:origin+'/account?checkout=cancelled',client_reference_id:user.github_id,
      ...(user.stripe_customer_id?{customer:user.stripe_customer_id}:{}),metadata,subscription_data:{metadata}});
    return value.url;
  };
  const portal=async session=>{
    if(!configured) throw new Error('BILLING_NOT_CONFIGURED');const user=store.user(session.user.github_id);
    if(!user?.stripe_customer_id) throw new Error('BILLING_CUSTOMER_NOT_FOUND');
    return (await stripe.billingPortal.sessions.create({customer:user.stripe_customer_id,return_url:origin+'/account'})).url;
  };
  const webhook=async(body,signature)=>{
    if(!configured || typeof signature!=='string') throw new Error('BILLING_NOT_CONFIGURED');
    const event=stripe.webhooks.constructEvent(body,signature,webhookSecret);
    let subscription=null,githubId=null;
    if(event.type==='checkout.session.completed') {
      const checkoutSession=event.data.object;githubId=checkoutSession.metadata?.github_user_id??checkoutSession.client_reference_id;
      if(typeof checkoutSession.subscription==='string') subscription=await stripe.subscriptions.retrieve(checkoutSession.subscription);
      else subscription=checkoutSession.subscription;
    } else if(['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted'].includes(event.type)) {
      subscription=event.data.object;githubId=subscription.metadata?.github_user_id;
    } else return {handled:false};
    if(!subscription || !githubId) return {handled:false};
    const customerId=typeof subscription.customer==='string'?subscription.customer:subscription.customer?.id;
    await store.applySubscription({event_id:event.id,github_id:String(githubId),customer_id:customerId,
      subscription_id:subscription.id,status:subscription.status,current_period_end:periodEnd(subscription)});
    return {handled:true};
  };
  return {configured,checkout,portal,webhook};
}
